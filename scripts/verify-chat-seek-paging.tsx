/*
 * Regression: a real SGR rail click seeks a projected row inside last-120 but
 * outside the mounted window. Assert physical xterm visibility after release
 * and redraw, and same-batch End/PageDown cancellation with late-frame checks.
 * Synthetic durable events only; no real sessions or credentials. Run through
 * `node scripts/verify-chat-seek-paging.mjs` for isolated production setup.
 */
import assert from 'node:assert/strict'
import { closeSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

assert.equal(process.env.NODE_ENV, 'production')
const scratch = process.env.DSH_CHAT_SEEK_SCRATCH
const tempRoot = process.env.DSH_CHAT_SEEK_TEMP_ROOT
assert.ok(typeof scratch === 'string' && typeof tempRoot === 'string', 'run through the isolated supervisor')
assert.equal(realpathSync(tempRoot), tempRoot, 'temporary root must be canonical')
assert.equal(dirname(scratch), tempRoot, 'scratch must be a direct child of the temporary root')
assert.ok(basename(scratch).startsWith('dsh-chat-seek-paging-'), 'invalid scratch prefix')
assert.equal(realpathSync(scratch), scratch, 'scratch must not be a symlink')
const scratchStat = lstatSync(scratch)
assert.ok(scratchStat.isDirectory(), 'scratch must be a directory')
if (process.platform !== 'win32') {
  assert.equal(typeof process.getuid, 'function', 'POSIX scratch ownership must be verifiable')
  assert.equal(scratchStat.uid, process.getuid!(), 'scratch must be owned by this user')
  assert.equal(scratchStat.mode & 0o077, 0, 'scratch must be private')
}
assert.equal(process.env.HOME, join(scratch, 'home'))
assert.equal(process.env.DSH_TUI_GEOMETRY_TRACE, join(scratch, 'geometry.jsonl'))
const [React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel }, { mountChannelUi }, { registerTuiChannel }, { bindChannelCommands }, { settled, sleep }, { default: inkInstances }] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'), import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'), import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel-ui.js'), import('../src/adapter/channel/host-registry.js'),
  import('../src/dsh-adapter/channel/commands.js'), import('./lib/term-test.mjs'), import('../src/ink/instances.js'),
])
type Event = { type: string; seq: number; time: number; data: Record<string, unknown> }
const events: Event[] = []
const append = (type: string, data: Record<string, unknown>) => { const event = { type, seq: events.length + 1, time: events.length + 1, data }; events.push(event); return event }
const seqs: number[] = []
for (let turn = 1; turn <= 2; turn++) {
  seqs.push(append('user/message', { id: `human-${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text: `RAIL-TARGET-${turn}` }] }).seq)
  append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `ANSWER-${turn}` }] } })
  const count = turn === 1 ? 45 : 80
  for (let n = 0; n < count; n++) {
    const callId = `synthetic-${turn}-${n}`
    append('tool/call', { turn, step: n + 2, callId, name: 'bash', arguments: JSON.stringify({ command: `echo ${callId}` }) })
    append('tool/result', { turn, step: n + 2, callId, message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: `RESULT-${turn}-${n}` }] } })
  }
}
const callbacks = new Map<string, Set<(...args: unknown[]) => unknown>>()
const cleanups: (() => void)[] = []
const agent = { id: 'rail-fixture', status: 'idle', session: { id: 'synthetic-only', seq: events.at(-1)!.seq, events, header: { cwd: scratch } }, ctx: { on: () => () => undefined }, followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true } }
const services: Record<string, unknown> = {
  settings: { describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: {}, value: {} }, { ns: 'dsh-tui', revision: 1, user: {}, value: { recapOnOpen: false } }], get: () => ({}), mutate: async () => undefined },
  credentials: { resolve: async () => undefined, set: async () => undefined, unset: async () => undefined },
  llm: { listConfigurableProviders: () => [], discoverModels: async () => [] },
}
const ctx = {
  on(name: string, listener: (...args: unknown[]) => unknown) { const set = callbacks.get(name) ?? new Set(); set.add(listener); callbacks.set(name, set); return () => { set.delete(listener) } },
  effect(setup: () => () => void) { cleanups.push(setup()) }, get(name: string) { return services[name] }, logger: { warn() {} },
}
const raw = createChannel(ctx as never, agent as never, { model: 'model', provider: 'provider', cwd: scratch, activity: false, whale: false, whaleIdle: false, minimalUi: true, smoothStreaming: false })
const unregister = registerTuiChannel(ctx, raw)
const mount = mountChannelUi(ctx, raw, undefined, 'new')
bindChannelCommands(raw, mount.channel)
const COLS = 100, ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
let pending = 0, frames = 0
// Ink's synchronous teardown writes to stdout.fd; never let it touch fd 1.
const fakeFd = openSync(join(scratch, 'tty-sink'), 'w')
class Stdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true; fd = fakeFd
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) { pending++; term.write(String(chunk), () => { pending--; done() }) }
}
class Stdin extends PassThrough { isTTY = true; setRawMode() { return this } ref() { return this } unref() { return this } }
const stdout = new Stdout(), stdin = new Stdin()
const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
type Node = { nodeValue?: string; childNodes?: Node[]; scrollTop?: number; scrollHeight?: number; scrollViewportHeight?: number; scrollViewportTop?: number }
const root = (): Node | undefined => (inkInstances.get(stdout as never) as unknown as { rootNode?: Node } | undefined)?.rootNode
const walk = (node: Node | undefined, predicate: (node: Node) => boolean): Node | undefined => {
  if (!node) return undefined
  if (predicate(node)) return node
  for (const child of node.childNodes ?? []) { const found = walk(child, predicate); if (found) return found }
  return undefined
}
const scroll = () => walk(root(), node => node.scrollViewportHeight !== undefined)
const screen = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '')
const ticks = () => Array.from({ length: ROWS }, (_, y) => {
  const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
  const glyph = (line?.getCell(COLS - 2)?.getChars() ?? '') + (line?.getCell(COLS - 1)?.getChars() ?? '')
  return ['━━', '──', ' ─'].includes(glyph) ? y : -1
}).filter(y => y >= 0)
const activeTick = () => ticks().findIndex(y => { const line = term.buffer.active.getLine(term.buffer.active.baseY + y); return line?.getCell(COLS - 2)?.getChars() === '━' && line?.getCell(COLS - 1)?.getChars() === '━' })
const notes = (): Array<{ start: number; end: number; rowCount: number }> => {
  try { return readFileSync(process.env.DSH_TUI_GEOMETRY_TRACE!, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => { const note = JSON.parse(line).list; return note ? [note] : [] }) } catch { return [] }
}
const prompt = 'RAIL-TARGET-2'
const mounted = () => !!walk(scroll(), node => typeof node.nodeValue === 'string' && node.nodeValue.includes(prompt))
const physicalVisible = () => { const top = scroll()?.scrollViewportTop ?? 0, h = scroll()?.scrollViewportHeight ?? 0; return pending === 0 && screen().slice(top, top + h).some(line => line.includes(prompt)) }
const click = (ordinal: number, suffix = '') => { const y = ticks()[ordinal]; assert.notEqual(y, undefined); stdin.write(`\x1b[<0;${COLS};${y! + 1}M\x1b[<0;${COLS};${y! + 1}m${suffix}`) }
let app: Awaited<ReturnType<typeof render>> | undefined
const store = new QuestionStore()
const tree = () => <AlternateScreen><Chat channel={mount.channel} questionStore={store} onExit={() => undefined} fullscreen trajectorySeen /></AlternateScreen>
try {
  const rows = mount.channel.rows
  const index = rows.findIndex(row => row.kind === 'user' && row.seq === seqs[1])
  const boundary = Math.max(0, rows.length - 120)
  assert.ok(rows.length > 120 && index > boundary && index < rows.length - 1, 'target must be strictly inside an active last-120 slice')
  const listIndex = index - boundary
  console.log(`PROJECTION ${JSON.stringify({ count: rows.length, index, boundary, listIndex, nearbyKinds: rows.slice(index - 1, index + 2).map(row => row.kind) })}`)
  app = await render(tree(), { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, patchConsole: false, exitOnCtrlC: false, onFrame: () => { frames++ } })
  assert.ok(await settled(() => pending === 0 && ticks().length === 2 && notes().length > 0, { timeoutMs: 5000 }), 'fixture must paint both turn cells')
  const initial = notes().at(-1)!
  assert.equal(initial.rowCount, 120, 'sampled visible slice must correspond to the last 120 projected rows')
  assert.ok(listIndex < initial.start || listIndex >= initial.end, 'target must lie outside mounted window')
  assert.equal(mounted(), false, 'target text node must not be mounted before click')
  console.log(`INITIAL ${JSON.stringify({ initial, targetIndex: index, mounted: mounted(), ticks: ticks(), active: activeTick(), physical: physicalVisible() })}`)
  click(1)
  assert.ok(await settled(() => physicalVisible() && activeTick() === 1, { timeoutMs: 5000 }), 'real SGR click must land target on physical viewport and select its rail tick')
  await sleep(250) // 固定窗:探针 allow forceMount release and later renderer work.
  const afterRelease = frames
  app.rerender(tree())
  assert.ok(await settled(() => frames > afterRelease && pending === 0, { timeoutMs: 5000 }), 'a new frame must paint after release')
  assert.ok(physicalVisible() && activeTick() === 1, 'target must survive release in a new frame')
  const before = frames
  app.rerender(tree())
  assert.ok(await settled(() => frames > before && pending === 0, { timeoutMs: 5000 }), 'independent redraw must paint another frame')
  await sleep(250) // 固定窗:探针 detect post-redraw drift.
  assert.ok(physicalVisible() && activeTick() === 1, 'target must remain on physical screen after redraw')
  const targetTop = scroll()?.scrollTop ?? -1
  console.log(`LANDED ${JSON.stringify({ frames, active: activeTick(), mounted: mounted(), physical: physicalVisible(), scrollTop: targetTop })}`)
  // Start each same-batch cancellation with the old target demonstrably unmounted.
  const tail = () => pending === 0 && screen().some(line => line.includes('synthetic-2-79'))
  stdin.write('\x1b[F')
  assert.ok(await settled(tail, { timeoutMs: 5000 }), 'End returns to real tail')
  assert.ok(await settled(() => !mounted(), { timeoutMs: 5000 }), 'target unmounts at tail')
  click(1, '\x1b[F')
  assert.ok(await settled(tail, { timeoutMs: 5000 }), 'same-batch End must defeat in-flight forceMount')
  await sleep(300) // 固定窗:探针 a late seek must not pull off the tail.
  assert.ok(tail() && !physicalVisible(), 'End cancellation must persist after deferred work')
  // Move one page up first: PageDown now has real downward work, so an
  // unchanged tail cannot be mistaken for a delivered key.
  stdin.write('\x1b[5~')
  assert.ok(await settled(() => pending === 0 && !tail(), { timeoutMs: 5000 }), 'PageUp prepares a non-bottom position')
  console.log(`PAGEUP ${JSON.stringify({ top: scroll()?.scrollTop, targetIndex: index, mounted: mounted(), notes: notes().at(-1) })}
`)
  assert.equal(mounted(), false, 'target still unmounted before PageDown race')
  const pageBefore = scroll()?.scrollTop ?? -1
  const framesBeforePage = frames
  const screenBeforePage = JSON.stringify(screen())
  click(1, '\x1b[6~')
  // An old snapshot already satisfies scrollTop > targetTop. Require an actual
  // post-input paint and a changed physical screen before accepting it.
  const transitioned = await settled(() => frames > framesBeforePage && pending === 0 &&
    JSON.stringify(screen()) !== screenBeforePage && (scroll()?.scrollTop ?? -1) > targetTop && !physicalVisible(), { timeoutMs: 5000 })
  const transition = { frames, top: scroll()?.scrollTop ?? -1, physical: physicalVisible() }
  await sleep(300) // 固定窗:探针 a deferred seek or page motion may still be in flight.
  const observation = { frames, top: scroll()?.scrollTop ?? -1, physical: physicalVisible() }
  await sleep(200) // 固定窗:探针 require the eventual position to stay stable.
  const final = { frames, top: scroll()?.scrollTop ?? -1, physical: physicalVisible() }
  // Log even on failure: the old implementation should show whether the old
  // anchor reclaimed the viewport instead of producing a false green.
  console.log(`CANCEL ${JSON.stringify({ pageBefore, targetTop, framesBeforePage, transitioned, transition, observation, final, active: activeTick() })}`)
  assert.ok(transitioned, 'PageDown must produce a new changed physical frame below the target')
  assert.ok(final.frames > framesBeforePage && pending === 0, 'final observation must follow an actual post-input painted frame')
  assert.ok(final.top > targetTop, 'PageDown must finish below the independently measured target anchor')
  assert.equal(observation.top, final.top, 'eventual PageDown position must not drift back to pending target')
  assert.equal(observation.physical, false, 'target must remain off the physical screen during the stability window')
  assert.equal(final.physical, false, 'PageDown must cancel the target, not swallow input')
} finally {
  await app?.unmount()
  mount.dispose(); unregister(); raw.releaseContributions()
  for (const cleanup of cleanups.reverse()) cleanup()
  term.dispose(); closeSync(fakeFd)
}
