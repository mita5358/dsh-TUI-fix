/** Focused regression for DSH user-row folding/restoration; no live session or credentials.
 * Run: node --import tsx/esm scripts/verify-fold-back-user.ts
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatRow } from '../src/dsh-adapter/channel/types.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

// Isolate even when this script is run directly, before production imports.
const parent = realpathSync(tmpdir())
const scratch = mkdtempSync(join(parent, 'dsh-fold-user-'))
try {
  for (const key of Object.keys(process.env)) {
    if (key === 'HOME' || key === 'USERPROFILE' || key.startsWith('XDG_') || key.startsWith('DSH_') ||
      /TOKEN|SECRET|CREDENTIAL|API_KEY|PASSWORD|ACCESS_KEY|^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)) delete process.env[key]
  }
  for (const dir of ['home', 'config', 'cache', 'data', 'state', 'dsh', 'tmp']) mkdirSync(join(scratch, dir))
  Object.assign(process.env, {
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
    XDG_DATA_HOME: join(scratch, 'data'), XDG_STATE_HOME: join(scratch, 'state'),
    DSH_HOME: join(scratch, 'dsh'), DSH_TUI_HOME: join(scratch, 'dsh'),
    TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'), TSX_DISABLE_CACHE: '1',
  })
  const { foldBack, foldRows, restoreRowFromEvent } = await import('../src/dsh-adapter/channel/transcript.js')
  const { createDshTranslator } = await import('../src/dsh-adapter/backend/translate.js')
  const { createChannel } = await import('../src/dsh-adapter/channel.js')
  const { mountChannelUi } = await import('../src/dsh-adapter/channel-ui.js')

const user = (seq: number, content: unknown[], source: unknown = { kind: 'user' }): SessionEvent =>
  ({ seq, time: seq, type: 'user/message', data: { id: `u${seq}`, source, content } }) as unknown as SessionEvent
const text = (value: string) => ({ type: 'text', text: value })
const assistant = (seq: number): SessionEvent =>
  ({ seq, type: 'assistant/message', data: { message: { content: [text('assistant answer')] } } }) as unknown as SessionEvent
const row = (id: number, seq: number | undefined, value: string): ChatRow =>
  ({ id, kind: 'user', text: value, ...(seq === undefined ? {} : { seq }) })

// This test is intentionally first: on the original implementation a later
// assistant message clears folded/restored while the long text is only preview.
{
  const full = `first question ${'长'.repeat(260)} last sentence`
  const rows = [row(101, 10, full)]
  assert.equal(foldRows(rows, 0), 1)
  const preview = rows[0]!.text
  assert.notEqual(preview, full)
  assert.equal(foldBack(rows, [user(10, [text(full)]), assistant(11)]), 1)
  assert.equal(rows[0]!.id, 101)
  assert.equal(rows[0]!.seq, 10)
  assert.equal(rows[0]!.text, full, 'restored must mean full user text, not the preview')
  assert.equal(rows[0]!.folded, false)
  assert.equal(rows[0]!.restored, true)
}

// The unverified helper cannot bypass user source/preview checks or expose
// later attachment blocks; only foldBack may restore a user row.
{
  const target = row(102, 10, 'folded preview')
  restoreRowFromEvent(target, user(10, [text('prompt'), text('PRIVATE ATTACHMENT')]))
  assert.equal(target.text, 'folded preview')
}

// Multiple users, short and long, first duplicate seq wins. Only the first
// text block belongs in the bubble: later text can be @attachment contents.
{
  const long = 'AB'.repeat(180)
  const rows = [row(1, 5, 'short'), row(2, 9, long), row(3, 12, 'alpha')]
  foldRows(rows, 0)
  const events = [
    user(5, [text(' short ')]), assistant(6),
    user(9, [text(`  ${long}  `), { type: 'image', data: 'attachment' }, text('private attachment body')]),
    user(9, [text('duplicate must not win')]), assistant(10),
    user(12, [{ type: 'image', data: 'attachment' }, text(' alpha '), text('attachment body')]), assistant(13),
  ]
  assert.equal(foldBack(rows, events), 3)
  assert.deepEqual(rows.map(r => [r.id, r.seq, r.text, r.folded, r.restored]), [
    [1, 5, 'short', false, true], [2, 9, long, false, true], [3, 12, 'alpha', false, true],
  ])
}

// User indexing does not assume folded rows are sorted by seq.
{
  const rows = [row(50, 20, 'later'), row(51, 2, 'earlier')]
  foldRows(rows, 0)
  assert.equal(foldBack(rows, [user(2, [text('earlier')]), user(20, [text('later')])]), 2)
  assert.deepEqual(rows.map(r => r.text), ['later', 'earlier'])
}

// No event, a user at the wrong seq, or only an assistant at the same seq
// must never claim the truncated content has been restored.
for (const events of [[], [user(8, [text('wrong')]), assistant(9)], [assistant(7)]]) {
  const rows = [row(20, 7, 'Z'.repeat(300))]
  foldRows(rows, 0)
  const preview = rows[0]!.text
  assert.equal(foldBack(rows, events), 0)
  assert.equal(rows[0]!.text, preview)
  assert.equal(rows[0]!.folded, true)
  assert.notEqual(rows[0]!.restored, true)
}
{
  const rows = [row(21, undefined, 'x'.repeat(300))]
  foldRows(rows, 0)
  assert.equal(foldBack(rows, [user(1, [text('wrong')]), assistant(2)]), 0)
  assert.equal(rows[0]!.folded, true)
}

// Malformed historical payloads cannot prove a restoration and must not crash.
for (const data of [null, {}, { source: { kind: 'user' }, content: null },
  { source: { kind: 'user' }, content: [null] },
  { source: { kind: 'user' }, content: [{ type: 'text', text: 42 }] },
]) {
  const rows = [row(22, 7, 'x'.repeat(300))]
  foldRows(rows, 0)
  const event = { seq: 7, type: 'user/message', data } as unknown as SessionEvent
  assert.equal(foldBack(rows, [event, assistant(8)]), 0)
  assert.equal(rows[0]!.folded, true)
  assert.notEqual(rows[0]!.restored, true)
}

// A real image-only message has an empty projected body; folding never drops
// the attachment. Empty textual blocks use the same first-text/trim semantics.
{
  const rows = [row(30, 4, '')]
  const images = [{ id: 'image-1' }] as unknown as NonNullable<ChatRow['images']>
  rows[0]!.images = images
  foldRows(rows, 0)
  assert.equal(foldBack(rows, [user(4, [{ type: 'image', data: 'attachment' }, text('  ')])]), 1)
  assert.equal(rows[0]!.text, '')
  assert.equal(rows[0]!.images, images)
  assert.equal(rows[0]!.folded, false)
  assert.equal(rows[0]!.restored, true)
}

// Compare against the real stateful translator: the first 0.2.0 teammate
// prompt sheds its identity block, but a later ordinary prompt does not.
{
  const reminder = `<system-reminder>\nYou are teammate "alice".\nYour Team Lead is named "lead".\nUse list_agents({}) to find your teammates and their names.\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).\nTo message another teammate, use send_message({ target: "<teammate name>", message: "..." }).\n</system-reminder>\n\n`
  const first = 'first human prompt ' + 'P'.repeat(260)
  const second = 'second human prompt ' + 'Q'.repeat(260)
  const events = [
    user(1, [text(reminder), text(first), text('ATTACHMENT-CONTENT')]),
    user(3, [text(second), text('SECRET-ATTACHMENT')]),
    user(5, [text(reminder), text('later text is an attachment')]),
  ]
  const translator = createDshTranslator({ tools: () => undefined, scope: () => undefined, attachments: () => undefined })
  const translated = events.flatMap(event => translator.translateEvent(event)).filter(event => event.type === 'user.message' && event.source === 'user')
  assert.deepEqual(translated.map(event => event.text), [first, second, reminder.trim()])
  const rows = translated.map((event, index) => row(100 + index, event.seq, event.text))
  foldRows(rows, 0)
  assert.equal(foldBack(rows, events), 3)
  assert.deepEqual(rows.map(r => r.text), translated.map(event => event.text))
  assert.ok(rows.every(r => r.restored === true && r.folded === false))

  // Both the raw and legacy-stripped candidate have the same 200-character
  // preview but different full content: guessing either would be unsafe.
  const ambiguousRows = [row(200, 9, reminder.trim())]
  foldRows(ambiguousRows, 0)
  const before = ambiguousRows[0]!.text
  assert.equal(foldBack(ambiguousRows, [user(9, [text(reminder), text(reminder + 'different tail')])]), 0)
  assert.equal(ambiguousRows[0]!.text, before)
  assert.equal(ambiguousRows[0]!.folded, true)
  assert.notEqual(ambiguousRows[0]!.restored, true)
}

// Same-seq non-human sources and content which does not match the existing
// preview are not evidence that a human bubble was reconstructed.
for (const event of [
  user(7, [text('X'.repeat(300))], { kind: 'plugin' }),
  user(7, [text('X'.repeat(300))], { kind: 'agent-message', form: 'relay', senderSessionId: 'peer' }),
  user(7, [text('different'.repeat(50))]),
]) {
  const rows = [row(40, 7, 'X'.repeat(300))]
  foldRows(rows, 0)
  const before = rows[0]!.text
  assert.equal(foldBack(rows, [event, assistant(8)]), 0)
  assert.equal(rows[0]!.text, before)
  assert.equal(rows[0]!.folded, true)
  assert.notEqual(rows[0]!.restored, true)
}

// Synthetic durable log through the real channel seed, emitter and UI mount.
// One user round with 610 distinct assistant steps keeps the prompt in the
// open chunk while exceeding the 600-row folding window.
{
  const full = 'mounted prompt ' + 'M'.repeat(300)
  const events: SessionEvent[] = [user(1, [text(full), text('PRIVATE ATTACHMENT BODY')])]
  for (let step = 1; step <= 610; step += 1) {
    events.push({ seq: step + 1, time: step + 1, type: 'assistant/message', data: {
      turn: 1, step, message: { content: [text(`answer ${step}`)] },
    } } as unknown as SessionEvent)
  }
  const cleanups: Array<() => void> = []
  const ctx = {
    on: () => () => undefined,
    effect: (setup: () => () => void) => { cleanups.push(setup()) },
    get: () => undefined,
    logger: { warn() {} },
  }
  const agent = {
    id: 'synthetic-user-fold-agent', status: 'idle',
    session: { id: 'synthetic-user-fold-session', seq: events.length, events },
    ctx: { on: () => () => undefined },
    followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true },
  }
  const raw = createChannel(ctx as never, agent as never, { model: 'fixture', provider: 'fixture', cwd: scratch, activity: false })
  const mounted = mountChannelUi(ctx, raw, undefined, 'new')
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('channel did not publish folded user row')) }, 2000)
      const unsubscribe = mounted.channel.subscribe(() => {
        if (!mounted.channel.rows.some(r => r.kind === 'user' && r.seq === 1 && r.folded)) return
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      })
      raw.emitStream()
    })
    const before = mounted.channel.rows.find(r => r.kind === 'user' && r.seq === 1)
    assert.ok(before, 'real seed projected the user prompt')
    assert.ok(raw.rows.length > 600, 'real seed projected over 600 rows')
    assert.equal(before.folded, true, 'real emitter folded the old user row')
    assert.notEqual(before.text, full)
    assert.ok(mounted.channel.loadOlder() > 0, 'real UI loadOlder restored rows')
    const after = mounted.channel.rows.find(r => r.id === before.id)
    assert.equal(after?.seq, 1)
    assert.equal(after?.text, full)
    assert.equal(after?.folded, false)
    assert.equal(after?.restored, true)
    assert.ok(!after?.text.includes('PRIVATE ATTACHMENT BODY'))
  } finally {
    mounted.dispose()
    raw.releaseContributions()
    for (const cleanup of cleanups.reverse()) cleanup()
  }
}

// A real folded-user batch, separate from the assistant/tool click budget.
// Timings are diagnostic (median of five), while counts and event traversal
// are deterministic; no host-dependent wall-clock threshold is relaxed.
{
  const count = 10_000
  const full = 'batch question ' + 'x'.repeat(280)
  const durable = Array.from({ length: count }, (_, i) => user(i + 1, [text(full)]))
  let traversed = 0
  const events: readonly SessionEvent[] = new Proxy(durable, {
    get(target, prop, receiver) {
      if (prop === Symbol.iterator) return function* () {
        for (const event of target) { traversed += 1; yield event }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  const times: number[] = []
  for (let run = 0; run < 5; run += 1) {
    const rows = Array.from({ length: count }, (_, i) => row(i + 1, i + 1, full))
    assert.equal(foldRows(rows, 0), count)
    traversed = 0
    const start = process.hrtime.bigint()
    assert.equal(foldBack(rows, events), count)
    times.push(Number(process.hrtime.bigint() - start) / 1e6)
    assert.equal(traversed, count, 'events are traversed exactly once, not once per user row')
    assert.ok(rows.every(r => r.text === full && r.restored === true && r.folded === false))
  }
  times.sort((a, b) => a - b)
  console.log(`${count} real folded users: median ${times[2]!.toFixed(1)} ms / 5 runs`)
}

console.log('verify-fold-back-user OK')
} finally {
  // Remove only the exact private directory we just created, never a symlink
  // replacement or a path outside the verified real temporary parent.
  if (dirname(scratch) !== parent || realpathSync(scratch) !== scratch) throw new Error('refusing unsafe scratch cleanup')
  rmSync(scratch, { recursive: true })
}
