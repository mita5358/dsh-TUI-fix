/**
 * Regression: rail seek into an unloaded DSH chunk whose materialized prompt
 * is older than MessageList's last-120 row slice. Uses synthetic in-memory
 * events, the real channel/mount/Chat, SGR mouse input and headless xterm.
 * The fixture uses synthetic in-memory events. A clean, explicitly authorized
 * launcher is required: JSX loaders/preloads run before these guards, which
 * do not enforce network or native-child isolation. Do not assume inherited
 * configuration or profiles are inaccessible.
 * Illustrative entry (not an isolated launcher):
 * NODE_ENV=production node --import tsx/esm scripts/verify-rail-window-seek.tsx
 */
import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

// The loader/JSX runtime runs before this module body: the launcher must
// already be clean and set production before process startup.
const tempRoot = realpathSync(tmpdir())
const parentIdentity = lstatSync(tempRoot, { bigint: true })
const scratch = mkdtempSync(join(tempRoot, 'dsh-rail-window-seek-'))
console.error(`SCRATCH-CREATED ${scratch}`)
const scratchIdentity = lstatSync(scratch, { bigint: true })
const verifyScratch = (): void => {
  const parent = lstatSync(tempRoot, { bigint: true })
  const current = lstatSync(scratch, { bigint: true })
  if (
    !parent.isDirectory() || parent.dev !== parentIdentity.dev || parent.ino !== parentIdentity.ino ||
    dirname(scratch) !== tempRoot || !basename(scratch).startsWith('dsh-rail-window-seek-') ||
    realpathSync(scratch) !== scratch || !current.isDirectory() ||
    current.dev !== scratchIdentity.dev || current.ino !== scratchIdentity.ino ||
    current.uid !== scratchIdentity.uid || current.mode !== scratchIdentity.mode ||
    (process.platform !== 'win32' &&
      (typeof process.getuid !== 'function' || current.uid !== BigInt(process.getuid()) || (current.mode & 0o077n) !== 0n))
  ) throw new Error(`refusing unsafe scratch path: ${scratch}`)
}
verifyScratch()
const tracePath = join(scratch, 'geometry.jsonl')
// Do not restore inherited user paths while asynchronous teardown may still
// run. This standalone process exits after the regression.
for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('DSH_TUI_')) delete process.env[key]
Object.assign(process.env, {
  HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), DSH_HOME: join(scratch, 'dsh-home'),
  XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
  XDG_DATA_HOME: join(scratch, 'data'), XDG_STATE_HOME: join(scratch, 'state'), XDG_RUNTIME_DIR: join(scratch, 'runtime'),
  TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'),
  FORCE_COLOR: '3', DSH_TUI_THEME: 'dark', DSH_TUI_LANG: 'zh', DSH_TUI_GEOMETRY_TRACE: tracePath,
})
delete process.env.NO_COLOR
delete process.env.TMUX
delete process.env.STY
mkdirSync(process.env.HOME!, { recursive: true })
mkdirSync(process.env.TMPDIR!, { recursive: true })
mkdirSync(process.env.XDG_RUNTIME_DIR!, { recursive: true, mode: 0o700 })

const [React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel }, { mountChannelUi }, { registerTuiChannel }, { bindChannelCommands }, { settled, sleep }, { default: inkInstances }] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'), import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'), import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel-ui.js'), import('../src/adapter/channel/host-registry.js'),
  import('../src/dsh-adapter/channel/commands.js'), import('./lib/term-test.mjs'), import('../src/ink/instances.js'),
])

type Event = { type: string; seq: number; time: number; data: Record<string, unknown> }
const events: Event[] = []
const seqs: number[] = []
const append = (type: string, data: Record<string, unknown>) => {
  const event = { type, seq: events.length + 1, time: events.length + 1, data }
  events.push(event)
  return event
}
for (let turn = 1; turn <= 12; turn++) {
  seqs.push(append('user/message', { id: `human-${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text: `WINDOW-PROMPT-${turn}` }] }).seq)
  if (turn < 12) append('tool/call', { turn, step: 1, callId: `weight-${turn}`, name: 'ask_user_question', arguments: JSON.stringify({ unused: 'x'.repeat(300_000) }) })
  append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `WINDOW-ANSWER-${turn}` }] } })
  // Small calls are genuine projected rows in the latest (unfolded) turn.
  // They put the selected old prompt strictly outside the post-reveal cap.
  if (turn === 12) for (let n = 0; n < 180; n++) {
    const callId = `tail-${n}`
    append('tool/call', { turn, step: n + 2, callId, name: 'bash', arguments: JSON.stringify({ command: `echo tail-${n}` }) })
    append('tool/result', { turn, step: n + 2, callId, message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: `TAIL-RESULT-${n}` }] } })
  }
}
const callbacks = new Map<string, Set<(...args: unknown[]) => unknown>>()
const cleanups: (() => void)[] = []
const agent = { id: 'window-seek', status: 'idle', session: { id: 'synthetic-session', seq: events.at(-1)!.seq, events, header: { cwd: scratch } }, ctx: { on: () => () => undefined }, followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true } }
const services: Record<string, unknown> = {
  settings: { describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: {}, value: {} }, { ns: 'dsh-tui', revision: 1, user: {}, value: { recapOnOpen: false } }], get: () => ({}), mutate: async () => undefined },
  credentials: { resolve: async () => undefined, set: async () => undefined, unset: async () => undefined },
  llm: { listConfigurableProviders: () => [], discoverModels: async () => [] },
}
const ctx = {
  on(name: string, listener: (...args: unknown[]) => unknown) { const set = callbacks.get(name) ?? new Set(); set.add(listener); callbacks.set(name, set); return () => { set.delete(listener) } },
  effect(setup: () => () => void) { cleanups.push(setup()) },
  get(name: string) { return services[name] }, logger: { warn() {} },
}
const raw = createChannel(ctx as never, agent as never, { model: 'model', provider: 'provider', cwd: scratch, activity: false, whale: false, whaleIdle: false, minimalUi: true, smoothStreaming: false })
const unregister = registerTuiChannel(ctx, raw)
const mount = mountChannelUi(ctx, raw, undefined, 'new')
const reveals: Array<{ requested: number; returned: number }> = []
let overrideRows: typeof mount.channel.rows | undefined
const channel = new Proxy(mount.channel, { get(target, property) {
  if (property === 'rows' && overrideRows !== undefined) return overrideRows
  const value = Reflect.get(target, property, target)
  if (property !== 'revealRow' || typeof value !== 'function') return value
  return (id: number) => { const returned = value(id); reveals.push({ requested: id, returned }); return returned }
} })
bindChannelCommands(raw, mount.channel)

const COLS = 100, ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
let pending = 0
class Stdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
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
const screen = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '')
const ticks = () => Array.from({ length: ROWS }, (_, y) => {
  const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
  const glyph = (line?.getCell(COLS - 2)?.getChars() ?? '') + (line?.getCell(COLS - 1)?.getChars() ?? '')
  return ['━━', '──', ' ─'].includes(glyph) ? y : -1
}).filter(y => y >= 0)
const activeTick = () => ticks().findIndex(y => {
  const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
  return line?.getCell(COLS - 2)?.getChars() === '━' && line?.getCell(COLS - 1)?.getChars() === '━'
})
const summaries = () => mount.channel.rows.filter(row => row.collapsed === true)
const listNotes = (): Array<{ start: number; end: number; rowCount: number }> => {
  try { return readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => { const note = JSON.parse(line).list; return note ? [note] : [] }) }
  catch { return [] }
}
let app: Awaited<ReturnType<typeof render>> | undefined
let frames = 0
const tree = () => <AlternateScreen><Chat channel={channel} questionStore={questionStore} fullscreen trajectorySeen onExit={() => {
  process.exitCode = 1
  console.error('RAIL_WINDOW_EXIT unexpected Chat exit')
}} /></AlternateScreen>
const questionStore = new QuestionStore()
try {
  const initial = summaries()
  assert.ok(initial.length >= 3, `fixture needs old chunks, got ${initial.length}`)
  const owner = initial[Math.floor(initial.length / 2)]!
  const target = owner.collapsedTurns?.[1]
  assert.ok(target, 'selected chunk must contain a non-first prompt')
  const ordinal = seqs.indexOf(target.seq)
  assert.ok(ordinal > 0)
  const prompt = `WINDOW-PROMPT-${ordinal + 1}`
  assert.equal(target.text, prompt)
  app = await render(tree(), { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, patchConsole: false, exitOnCtrlC: false, onFrame: () => { frames++ } })
  assert.ok(await settled(() => pending === 0 && ticks().length === 12 && listNotes().length > 0), '12 ticks and list geometry must paint')
  assert.ok(summaries().some(row => row.id === owner.id), 'target is still unloaded before click')
  const y = ticks()[ordinal]!
  stdin.write(`\x1b[<0;${COLS};${y + 1}M\x1b[<0;${COLS};${y + 1}m`)
  assert.ok(await settled(() => reveals.length > 0 && !summaries().some(row => row.id === owner.id)), 'click materializes owning chunk')
  assert.ok(initial.filter(row => row.id !== owner.id).every(row => summaries().some(current => current.id === row.id)), 'unrelated chunks must remain collapsed')
  const loaded = mount.channel.rows.find(row => row.kind === 'user' && row.seq === target.seq)
  assert.ok(loaded, 'materialized target seq must exist')
  assert.equal(reveals.at(-1)?.requested, target.id, 'mouse tick selected the intended virtual prompt')
  assert.equal(reveals.at(-1)?.returned, loaded.id, 'reveal resolves the exact materialized prompt')
  const index = mount.channel.rows.findIndex(row => row.id === loaded.id)
  const total = mount.channel.rows.length
  assert.ok(index < total - 120, `target index ${index} must lie before last 120 of ${total}`)
  const waitUntil = async (pred: () => boolean): Promise<boolean> => {
    for (let n = 0; n < 300; n++) {
      if (pred()) return true
      await sleep(30) // 固定窗:探针 poll a state that a later frame can flip back (pending write)
    }
    return false
  }
  const atTop = () => {
    const top = walk(root(), n => n.scrollViewportHeight !== undefined)?.scrollViewportTop ?? 0
    return pending === 0 && activeTick() === ordinal && screen().slice(Math.max(0, top - 1), top + 2).some(line => line.includes(prompt))
  }
  const landed = await settled(atTop, { timeoutMs: 5000, stepMs: 20 })
  // Chat clears forceMount on a zero-delay macrotask after mounting. Let that
  // task run, then force an independent root update and require a painted frame.
  await sleep(250) // 固定窗:探针 observe anchor after the forceMount release task
  const framesBeforeRedraw = frames
  app.rerender(tree())
  const redrawn = await settled(() => frames > framesBeforeRedraw && pending === 0)
  await sleep(250) // 固定窗:探针 detect late drift after the confirmed redraw
  const stable = atTop()
  const notes = listNotes()
  const maxWindow = Math.max(...notes.map(n => n.end - n.start))
  const maxRows = Math.max(...notes.map(n => n.rowCount))
  const scroll = walk(root(), n => n.scrollViewportHeight !== undefined)
  console.log(`WINDOW_SEEK ${JSON.stringify({ prompt, seq: target.seq, projectedIndex: index, projectedRows: total, tailBoundary: total - 120, reveals, landed, redrawn, stable, activeTick: activeTick(), mountedTarget: !!walk(root(), n => n.nodeValue === prompt), scroll: { top: scroll?.scrollTop, height: scroll?.scrollHeight, viewport: scroll?.scrollViewportHeight, viewportTop: scroll?.scrollViewportTop }, traceFrames: notes.length, maxRows, maxWindow, head: screen().slice(0, 6), tailScreen: screen().slice(-5), rowsLen: mount.channel.rows.length, digests: summaries().length, lastNotes: notes.slice(-6) })}`)
  assert.ok(notes.length > 0, 'geometry trace must contain MessageList samples')
  // The mounted window is the cost: the SLICE may hold the whole addressable
  // model after a far seek (the target must join the content model), but no
  // frame may mount more than the cap.
  // The SLICE may legitimately grow to (nearly) the whole addressable model:
  // a far seek has to lower the window floor so the target joins the content
  // model at all. The cost that matters is the MOUNTED window (`maxWindow`).
  assert.ok(maxRows <= Math.max(120, total, mount.channel.rows.length), `row model must not exceed the whole transcript (observed ${maxRows})`)
  assert.ok(maxWindow <= 120, `mounted row window must remain bounded (observed ${maxWindow})`)
  assert.ok(landed, 'clicked prompt must reach viewport top with its own active tick')
  assert.ok(redrawn, 'a later root update must actually paint')
  assert.ok(stable, 'clicked prompt must stay at viewport top after forceMount clears and redraw')
  stdin.write('\x1b[F')
  assert.ok(await settled(() => pending === 0 && screen().some(line => line.includes('tail-179')), { timeoutMs: 5000 }), 'End from an old seek must reach the real tail')
  const targetTick = ticks()[ordinal]!
  stdin.write(`\x1b[<0;${COLS};${targetTick + 1}M\x1b[<0;${COLS};${targetTick + 1}m`)
  assert.ok(await settled(atTop, { timeoutMs: 5000 }), 'repeat seek after End must return to the prompt')
  // The live projection may replace an entry without changing its array or length.
  const mutableRows = [...mount.channel.rows]
  overrideRows = mutableRows
  app.rerender(tree())
  // Capture the predicate INSIDE the wait loop: `settled` re-evaluates after
  // the loop returns, and a new stdout write can flip `pending` back to 1 in
  // that gap (xterm serializes frames), turning a correctly anchored frame
  // into a false negative under load.
  const copiedOk = await waitUntil(atTop)
  if (!copiedOk) console.log(`WINDOW_COPY ${JSON.stringify({ pending, activeTick: activeTick(), ordinal, scrollTop: walk(root(), n => n.scrollViewportHeight !== undefined)?.scrollTop, viewportTop: walk(root(), n => n.scrollViewportHeight !== undefined)?.scrollViewportTop, head: screen().slice(0, 6) })}`)
  assert.ok(copiedOk, 'copied fixture must preserve the current anchor')
  const replacement = 'WINDOW-REPLACED'
  mutableRows[index] = { ...loaded, text: replacement }
  app.rerender(tree())
  assert.ok(await settled(() => pending === 0 && screen().some(line => line.includes(replacement))), 'same-array same-length replacement must paint the new row')
  mutableRows[index] = loaded
  app.rerender(tree())
  assert.ok(await settled(atTop), 'restored prompt remains anchored after replacing the row twice')
  overrideRows = undefined
  app.rerender(tree())
  for (let n = 0; n < 220 && !screen().some(line => line.includes('tail-179')); n++) {
    stdin.write('\x1b[<65;90;20M')
    await sleep(20) // 固定窗:pacing feed distinct wheel events through the scroll path
  }
  const wheelBottom = await settled(() => pending === 0 && screen().some(line => line.includes('tail-179')), { timeoutMs: 5000 })
  console.log(`WINDOW_WHEEL ${JSON.stringify({ wheelBottom, scroll: { top: scroll?.scrollTop, height: scroll?.scrollHeight, viewport: scroll?.scrollViewportHeight } })}`)
  assert.ok(wheelBottom, 'continuous wheel scrolling must reach the real tail')
  stdin.write('\x1b[<64;90;20M')
  await sleep(100) // 固定窗:探针 wait for the wheel to leave the tail before testing End
  stdin.write('\x1b[F')
  const atBottom = await settled(() => pending === 0 && screen().some(line => line.includes('tail-179')), { timeoutMs: 5000 })
  console.log(`WINDOW_BOTTOM ${JSON.stringify({ atBottom, screen: screen().slice(-10), scroll: walk(root(), n => n.scrollViewportHeight !== undefined) && { top: scroll?.scrollTop, height: scroll?.scrollHeight, viewport: scroll?.scrollViewportHeight } })}`)
  assert.ok(atBottom, 'End must return to the actual tail, not the page boundary')
  const allNotes = listNotes()
  // `rowCount` is the SLICE length, not the mount: a far seek legitimately
  // keeps the whole addressable model in the window (the target must be in
  // it). The bound that protects the frame is the mounted band.
  assert.ok(allNotes.every(note => note.end - note.start <= 120), 'navigation and scrolling must remain bounded on every sampled frame')
} finally {
  let teardownFailed = false
  const failure = (part: string, error: unknown): void => {
    teardownFailed = true
    process.exitCode = 1
    console.error(`TEARDOWN ${part}:`, error)
  }
  try { await app?.unmount() } catch (error) { failure('app', error) }
  try { mount.dispose() } catch (error) { failure('mount', error) }
  try { unregister() } catch (error) { failure('registration', error) }
  try { raw.releaseContributions() } catch (error) { failure('channel', error) }
  for (const cleanup of cleanups.reverse()) {
    try { cleanup() } catch (error) { failure('effect', error) }
  }
  try { term.dispose() } catch (error) { failure('terminal', error) }
  // Keep scratch if teardown may have left writers. Identity verification and
  // recursive removal are path-based and not atomic against replacement.
  if (teardownFailed) {
    console.error(`SCRATCH ${scratch}`)
  } else {
    try {
      verifyScratch()
      rmSync(scratch, { recursive: true })
    } catch (error) {
      process.exitCode = 1
      console.error(`SCRATCH-CLEANUP ${scratch}:`, error)
    }
  }
}
