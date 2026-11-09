/*
 * Run each case via verify-chat-pending-wheel.mjs, never directly.
 * Real Chat + projected synthetic events + headless xterm.
 * Each process is cold: especially do not warm the turn-2 coordinate first.
 * down tests the unmounted force-mount race at positional bottom with no DOM
 * anchor. onWheel instrumentation is observational and calls the real handler.
 */
import assert from 'node:assert/strict'
import { closeSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

assert.equal(process.env.NODE_ENV, 'production')
const scratch = process.env.DSH_CHAT_SEEK_SCRATCH
const tempRoot = process.env.DSH_CHAT_SEEK_TEMP_ROOT
const which = process.env.DSH_CHAT_SEEK_CASE
assert.ok(scratch && tempRoot && which)
assert.equal(realpathSync(tempRoot), tempRoot)
assert.equal(dirname(scratch), tempRoot)
assert.ok(basename(scratch).startsWith('dsh-chat-seek-paging-'))
assert.equal(realpathSync(scratch), scratch)
const st = lstatSync(scratch)
assert.ok(st.isDirectory())
if (process.platform !== 'win32') {
  assert.equal(st.uid, process.getuid!())
  assert.equal(st.mode & 0o077, 0)
}
assert.equal(process.env.HOME, join(scratch, 'home'))
assert.equal(process.env.DSH_TUI_GEOMETRY_TRACE, join(scratch, 'geometry.jsonl'))
const [React, { Terminal: XTerm }, ui, { Chat }, { QuestionStore }, { createChannel }, { mountChannelUi }, { registerTuiChannel }, { bindChannelCommands }, { settled, sleep }, { default: inkInstances }, prefs, { panelStore }] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'), import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'), import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel-ui.js'), import('../src/adapter/channel/host-registry.js'),
  import('../src/dsh-adapter/channel/commands.js'), import('./lib/term-test.mjs'),
  import('../src/ink/instances.js'), import('../src/tuiDisplayPrefs.js'),
  import('../src/components/sidePanel/PanelStore.js'),
])
const { render, AlternateScreen, ScrollBox, Text } = ui

type Event = { type: string; seq: number; time: number; data: Record<string, unknown> }
const events: Event[] = []
const append = (type: string, data: Record<string, unknown>) => {
  const event = { type, seq: events.length + 1, time: events.length + 1, data }
  events.push(event); return event
}
const seqs: number[] = []
for (let turn = 1; turn <= 2; turn++) {
  seqs.push(append('user/message', { id: `human-${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text: `RAIL-TARGET-${turn}` }] }).seq)
  append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `ANSWER-${turn}` }] } })
  for (let n = 0; n < (turn === 1 ? 45 : 80); n++) {
    const callId = `synthetic-${turn}-${n}`
    append('tool/call', { turn, step: n + 2, callId, name: 'bash', arguments: JSON.stringify({ command: `echo ${callId}` }) })
    append('tool/result', { turn, step: n + 2, callId, message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: `RESULT-${turn}-${n}` }] } })
  }
}
const callbacks = new Map<string, Set<(...args: unknown[]) => unknown>>()
const cleanups: (() => void)[] = []
const agent = { id: 'wheel-fixture', status: 'idle', session: { id: 'synthetic-only', seq: events.at(-1)!.seq, events, header: { cwd: scratch } }, ctx: { on: () => () => undefined }, followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true } }
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
// Synthetic load-on-reveal boundary: the real projector supplies every row,
// but initially expose turn 2 as one collapsed history digest. Revealing its
// synthetic navigation ID swaps the exact projected row back in. This forces
// Chat's real revealAndSeekRow path without a coordinate scrollTo first.
const projectedRows = mount.channel.rows.slice()
const targetIndex = projectedRows.findIndex(row => row.kind === 'user' && row.seq === seqs[1])
assert.ok(targetIndex >= 0)
const targetRow = projectedRows[targetIndex]!
const navigationId = -987654321
let syntheticRows = projectedRows.slice()
syntheticRows[targetIndex] = {
  id: -987654320, kind: 'notice', text: 'SYNTHETIC COLLAPSED CHUNK', restored: true,
  collapsed: true, collapsedTurns: [{ id: navigationId, seq: seqs[1]!, text: 'RAIL-TARGET-2', imageCount: 0 }],
} as typeof targetRow
let revealCalls = 0
const channel = new Proxy(mount.channel, {
  get(target, key) {
    if (key === 'rows') return syntheticRows
    if (key === 'version') return target.version + revealCalls
    if (key === 'revealRow') return (id: number) => {
      if (id !== navigationId) return target.revealRow(id)
      revealCalls++
      syntheticRows = projectedRows.slice()
      return targetRow.id
    }
    return Reflect.get(target, key, target)
  },
})
const COLS = which === 'panel' ? 140 : 100, ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
let pending = 0, frames = 0
const parsed: string[][] = []
const screen = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '')
const fakeFd = openSync(join(scratch, 'tty-sink'), 'w')
class Stdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true; fd = fakeFd
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) {
    pending++
    term.write(String(chunk), () => { parsed.push(screen()); pending--; done() })
  }
}
class Stdin extends PassThrough { isTTY = true; setRawMode() { return this } ref() { return this } unref() { return this } }
const stdout = new Stdout(), stdin = new Stdin()
const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
type Node = { nodeValue?: string; childNodes?: Node[]; scrollTop?: number; scrollHeight?: number; scrollViewportHeight?: number; scrollViewportTop?: number; stickyScroll?: boolean; pendingScrollDelta?: number; scrollAnchor?: unknown; attributes?: Record<string, unknown>; _eventHandlers?: Record<string, unknown> }
const root = (): Node | undefined => (inkInstances.get(stdout as never) as unknown as { rootNode?: Node } | undefined)?.rootNode
const walk = (node: Node | undefined, predicate: (node: Node) => boolean): Node | undefined => {
  if (!node) return undefined
  if (predicate(node)) return node
  for (const child of node.childNodes ?? []) { const found = walk(child, predicate); if (found) return found }
  return undefined
}
const transcript = () => walk(root(), node => node.scrollViewportHeight !== undefined && !!walk(node, child => child.nodeValue?.includes('synthetic-2-79') === true))
const panel = () => walk(root(), node => node.scrollViewportHeight !== undefined && !!walk(node, child => child.nodeValue?.includes('PANEL-LINE-00') === true))
const prompt = 'RAIL-TARGET-2'
let chatNode: Node | undefined
const mounted = () => !!walk(chatNode ?? transcript(), node => node.nodeValue?.includes(prompt) === true)
const physicalVisible = () => { const s = chatNode ?? transcript(); return pending === 0 && screen().slice(s?.scrollViewportTop ?? 0, (s?.scrollViewportTop ?? 0) + (s?.scrollViewportHeight ?? 0)).some(line => line.includes(prompt)) }
// The pinned round header repeats the prompt text above the transcript; paged
// paint checks must look at the transcript viewport only.
const viewportPainted = (lines: string[]) => { const s = chatNode ?? transcript(); return lines.slice(s?.scrollViewportTop ?? 0, (s?.scrollViewportTop ?? 0) + (s?.scrollViewportHeight ?? 0)).some(line => line.includes(prompt)) }
const tail = () => pending === 0 && screen().some(line => line.includes('synthetic-2-79'))
const notes = (): Array<{ start: number; end: number; rowCount: number }> => {
  try { return readFileSync(process.env.DSH_TUI_GEOMETRY_TRACE!, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => { const note = JSON.parse(line).list; return note ? [note] : [] }) } catch { return [] }
}
// Scan actual xterm cells rather than assume the rail stays at the terminal edge.
const rail = () => {
  const columns: Array<{ x: number; ys: number[] }> = []
  for (let x = 0; x < COLS - 1; x++) {
    const ys: number[] = []
    for (let y = 0; y < ROWS; y++) {
      const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
      const glyph = (line?.getCell(x)?.getChars() ?? '') + (line?.getCell(x + 1)?.getChars() ?? '')
      if (['━━', '──', ' ─'].includes(glyph)) ys.push(y)
    }
    if (ys.length > 0) columns.push({ x, ys })
  }
  // Box rules are painted on the same rows across the whole width; strip those
  // shared rows so only the rail column keeps its per-turn tick cells.
  const perRow = new Map<number, number>()
  for (const column of columns) for (const y of column.ys) perRow.set(y, (perRow.get(y) ?? 0) + 1)
  const shared = new Set([...perRow].filter(([, count]) => count > COLS / 2).map(([y]) => y))
  return columns
    .map(column => ({ x: column.x, ys: column.ys.filter(y => !shared.has(y)) }))
    .filter(column => column.ys.length === 2)
}
const point = (needle: string) => {
  const lines = screen()
  for (let y = 0; y < lines.length; y++) { const x = lines[y]!.indexOf(needle); if (x >= 0) return { x, y } }
  return undefined
}
const snapshot = (node: Node) => ({ revealCalls, mounted: mounted(), anchor: node.scrollAnchor !== undefined, top: node.scrollTop ?? 0, max: Math.max(0, (node.scrollHeight ?? 0) - (node.scrollViewportHeight ?? 0)), sticky: node.stickyScroll ?? Boolean(node.attributes?.stickyScroll), debt: node.pendingScrollDelta ?? 0 })
const observations: Array<{ owner: string; before: ReturnType<typeof snapshot>; after: ReturnType<typeof snapshot>; deltaY: number }> = []
const instrument = (node: Node, owner: string) => {
  const handlers = node._eventHandlers
  assert.ok(handlers && typeof handlers.onWheel === 'function', `${owner} must have real onWheel`)
  const original = handlers.onWheel as (event: { deltaY: number }) => void
  handlers.onWheel = (event: { deltaY: number }) => {
    const before = snapshot(node)
    original(event)
    observations.push({ owner, before, after: snapshot(node), deltaY: event.deltaY })
  }
  return () => { handlers.onWheel = original }
}
let disposePanel: (() => void) | undefined
if (which === 'panel') {
  function TestPanel() {
    const panelRef = React.useRef<import('../src/ui.js').ScrollBoxHandle | null>(null)
    return <ScrollBox ref={panelRef} flexDirection="column" flexGrow={1}>
      {Array.from({ length: 90 }, (_, i) => <Text key={i}>{`PANEL-LINE-${String(i).padStart(2, '0')}`}</Text>)}
    </ScrollBox>
  }
  disposePanel = panelStore.register({ id: 'test:wheel', title: 'Test', source: 'plugin', pluginId: 'test', component: TestPanel }, { pluginId: 'test' })
  prefs.applySidePanelSplitEnabled(true); prefs.applySidePanelOpen(true); prefs.applySidePanelRatio(0.68); prefs.applySidePanelPanels('test:wheel')
}
let app: Awaited<ReturnType<typeof render>> | undefined
const store = new QuestionStore()
const tree = () => <AlternateScreen><Chat channel={channel} questionStore={store} onExit={() => undefined} fullscreen trajectorySeen /></AlternateScreen>
try {
  const rows = mount.channel.rows
  const index = rows.findIndex(row => row.kind === 'user' && row.seq === seqs[1])
  const boundary = Math.max(0, rows.length - 120), listIndex = index - boundary
  assert.ok(rows.length > 120 && index > boundary && index < rows.length - 1)
  app = await render(tree(), { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, patchConsole: false, exitOnCtrlC: false, onFrame: () => { frames++ } })
  assert.ok(await settled(() => pending === 0 && rail().length === 1 && notes().length > 0 && !!transcript() && tail() && (which !== 'panel' || (!!panel() && !!point('PANEL-LINE-00'))), { timeoutMs: 5000 }), 'fixture must paint tail, rail and requested panel')
  const initial = notes().at(-1)!
  assert.equal(initial.rowCount, 120)
  assert.ok(listIndex < initial.start || listIndex >= initial.end, 'target is outside mounted list window')
  assert.equal(mounted(), false)
  const t = transcript()!
  chatNode = t
  const removeTranscriptProbe = instrument(t, 'transcript')
  const p = which === 'panel' ? panel() : undefined
  const removePanelProbe = p ? instrument(p, 'panel') : () => undefined
  const wheelRow = (t.scrollViewportTop ?? 0) + Math.max(1, Math.floor((t.scrollViewportHeight ?? 2) / 2))
  const down = `\x1b[<65;10;${wheelRow + 1}M`
  const up = `\x1b[<64;10;${wheelRow + 1}M`
  assert.equal(rail().length, 1)
  const r = rail()[0]!, y = r.ys[1]!
  const click = `\x1b[<0;${r.x + 2};${y + 1}M\x1b[<0;${r.x + 2};${y + 1}m`
  const beforeFrames = frames, beforeParsed = parsed.length, beforeScreen = JSON.stringify(screen()), beforeTop = t.scrollTop ?? 0
  console.log(`INITIAL ${JSON.stringify({ which, index, initial, rail: r, transcript: snapshot(t), mounted: mounted() })}`)
  if (which === 'seek') {
    stdin.write(click)
    assert.ok(await settled(() => physicalVisible(), { timeoutMs: 5000 }), 'cold SGR rail seek must land on real parsed screen')
    assert.equal(revealCalls, 1, 'the collapsed turn must be revealed by its rail click')
    await sleep(300) // 固定窗:探针 verify seek stays after force-mount release.
    assert.ok(physicalVisible())
  } else if (which === 'overscroll') {
    await sleep(300) // 固定窗:探针 establish a quiet sticky baseline before checking absence of frames.
    assert.equal(pending, 0)
    const f = frames, k = parsed.length, image = JSON.stringify(screen()), base = snapshot(t)
    assert.ok(base.sticky && base.top >= base.max && !base.anchor && base.debt === 0)
    stdin.write(down.repeat(8))
    assert.ok(await settled(() => observations.length === 8, { timeoutMs: 5000 }), 'each real SGR wheel is delivered')
    await sleep(500) // 固定窗:探针 no new paint and no sticky break are negative invariants.
    assert.equal(pending, 0); assert.equal(frames, f, 'ordinary overscroll must schedule zero frames')
    assert.equal(JSON.stringify(screen()), image)
    assert.ok(snapshot(t).sticky && observations.every(o => o.before.sticky && o.after.sticky))
    assert.ok(parsed.slice(k).every(lines => JSON.stringify(lines) === image && !lines.some(line => line.includes('回到底部'))), 'no intermediate screen/pill flicker')
  } else {
    let suffix = which === 'down' ? down : up
    if (which === 'panel') {
      const cell = point('PANEL-LINE-00')!
      suffix = `\x1b[<65;${cell.x + 2};${cell.y + 1}M`
    }
    stdin.write(click + suffix) // One actual stdin chunk: click release and later intent in the same parser batch.
    {
      assert.ok(await settled(() => observations.length > 0, { timeoutMs: 5000 }), 'wheel must hit a real ScrollBox handler')
      const o = observations[0]!
      console.log(`WHEEL_EDGE ${JSON.stringify(o)}`)
      assert.equal(o.owner, which === 'panel' ? 'panel' : 'transcript', 'wheel must be position-routed to the intended box')
      assert.equal(o.before.revealCalls, 1, 'rail click must have requested reveal before wheel dispatch')
      assert.equal(o.before.mounted, false, 'target must still be unmounted at actual wheel dispatch, not just before stdin.write')
      if (which === 'down') {
        assert.equal(o.deltaY, 3)
        assert.equal(o.before.anchor, false, 'this is the deferred seek, not the mounted-anchor fix')
        assert.ok(o.before.sticky || (o.before.top >= o.before.max && o.before.debt >= 0), 'exercise bottom overscroll early return')
      }
      if (which === 'up') assert.equal(o.deltaY, -3)
    }
    if (which === 'panel') {
      assert.ok(await settled(() => pending === 0 && (p?.scrollTop ?? 0) > 0 && physicalVisible(), { timeoutMs: 5000 }), 'panel wheel actually scrolls the panel without canceling Chat seek')
      assert.equal(observations.filter(o => o.owner === 'transcript').length, 0)
    } else if (which === 'up') {
      assert.ok(await settled(() => frames > beforeFrames && pending === 0 && (t.scrollTop ?? 0) < beforeTop && JSON.stringify(screen()) !== beforeScreen, { timeoutMs: 5000 }), 'wheel-up must actually move and paint')
      await sleep(500) // 固定窗:探针 reject late deferred seek stealing viewport.
      assert.equal(physicalVisible(), false); assert.ok((t.scrollTop ?? 0) < beforeTop)
      assert.ok(parsed.slice(beforeParsed).every(lines => !viewportPainted(lines)), 'wheel-up must not briefly paint the old target')
    } else {
      // First check natural frames; an unchanged snapshot alone is not enough.
      await sleep(500) // 固定窗:探针 allow a pending seek to steal the view before any forced redraw.
      assert.equal(revealCalls, 1, 'the rail click must actually start a reveal before later input')
      assert.ok(tail() && !physicalVisible(), 'wheel-down must keep the natural viewport at the tail')
      assert.ok(parsed.slice(beforeParsed).every(lines => !viewportPainted(lines)), 'no natural frame may show the old target')
      // Also force a later commit to catch stale pending work.
      app.rerender(tree())
      assert.ok(await settled(() => frames > beforeFrames && pending === 0, { timeoutMs: 5000 }), 'must observe a parsed frame after the input batch')
      await sleep(500) // 固定窗:探针 allow deferred mount, anchor pass and release to run.
      assert.ok(tail() && !physicalVisible(), `${which}: old target must not reclaim tail`)
      assert.ok(parsed.slice(beforeParsed).every(lines => !viewportPainted(lines)), `${which}: no intermediate parsed frame may show the old target`)
    }
    if (which !== 'panel') {
      const f = frames
      app.rerender(tree())
      assert.ok(await settled(() => frames > f && pending === 0, { timeoutMs: 5000 }), 'force an independent parsed redraw')
      await sleep(300) // 固定窗:探针 reject drift after independent redraw.
      assert.equal(physicalVisible(), false, 'old target stays canceled after redraw')
    }
  }
  console.log(`RESULT ${JSON.stringify({ which, observations, frames, parsedFrames: parsed.length, transcript: snapshot(t), physical: physicalVisible(), tail: tail(), panelTop: p?.scrollTop })}`)
  removePanelProbe(); removeTranscriptProbe()
} finally {
  await app?.unmount()
  disposePanel?.(); mount.dispose(); unregister(); raw.releaseContributions()
  for (const cleanup of cleanups.reverse()) cleanup()
  term.dispose(); closeSync(fakeFd)
}
