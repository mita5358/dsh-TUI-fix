/**
 * Real channel history LRU + Chat/xterm fence-state regression. The target is
 * opened by SGR mouse; unrelated chunks are materialized via channel.revealRow
 * solely to force eviction. Synthetic records, no real sessions or credentials.
 * Run: node --import tsx/esm scripts/verify-code-fence-lru.tsx
 */
import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

// Ignore inherited harness paths and temp overrides: the fixture owns every
// DSH/XDG destination and never writes a real terminal fd.
for (const key of Object.keys(process.env)) if (key.startsWith('DSH_')) delete process.env[key]
delete process.env.TMPDIR
delete process.env.TMP
delete process.env.TEMP
const prefix = join(tmpdir(), 'code-fence-lru-')
const home = mkdtempSync(prefix)
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, '.dsh')
process.env.XDG_CONFIG_HOME = join(home, '.config')
process.env.XDG_CACHE_HOME = join(home, '.cache')
process.env.XDG_DATA_HOME = join(home, '.local', 'share')
process.env.XDG_STATE_HOME = join(home, '.local', 'state')
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
const [React, { Terminal }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel }, { mountChannelUi }, { registerTuiChannel }, { settled, sleep }, { default: inkInstances }] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'), import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'), import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel-ui.js'), import('../src/adapter/channel/host-registry.js'),
  import('./lib/term-test.mjs'), import('../src/ink/instances.js'),
])
type RawEvent = { type: string; seq: number; time: number; data: Record<string, unknown> }
const events: RawEvent[] = []
const append = (type: string, data: Record<string, unknown>) => {
  const seq = events.length + 1
  events.push({ type, seq, time: seq, data })
}
for (let n = 1; n <= 8; n++) {
  append('user/message', { id: `user-${n}`, source: { kind: 'user' }, content: [{ type: 'text', text: `LRU-PROMPT-${n}` }] })
  append('tool/call', { turn: n, step: 1, callId: `weight-${n}`, name: 'ask_user_question', arguments: JSON.stringify({ unused: 'x'.repeat(1_010_000) }) })
  const text = `answer ${n}\n\n\`\`\`js\nA_HEAD_${n}\nA_BODY_${n}\n\`\`\`\n\n~~~py\nB_HEAD_${n}\nB_BODY_${n}\n~~~`
  append('assistant/message', { turn: n, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } })
}
const cleanups: Array<() => void> = []
const agent = { id: 'lru-test', status: 'idle', session: { id: 'lru-session', seq: events.length, events, header: { cwd: home } }, ctx: { on: () => () => undefined }, followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true } }
const services: Record<string, unknown> = {
  settings: { describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: {}, value: {} }, { ns: 'dsh-tui', revision: 1, user: {}, value: { recapOnOpen: false } }], get: () => ({}), mutate: async () => undefined },
  credentials: { resolve: async () => undefined, set: async () => undefined, unset: async () => undefined },
  llm: { listConfigurableProviders: () => [], discoverModels: async () => [] },
  agents: {},
}
const ctx = { on: () => () => undefined, effect(setup: () => () => void) { cleanups.push(setup()) }, get: (name: string) => services[name], logger: { warn() {} } }
const raw = createChannel(ctx as never, agent as never, { model: 'model', provider: 'provider', cwd: home, activity: false, whale: false, whaleIdle: false, minimalUi: true, smoothStreaming: false })
const unregister = registerTuiChannel(ctx, raw)
const mount = mountChannelUi(ctx, raw, undefined, 'new')
const summaries = () => mount.channel.rows.filter(row => row.collapsed === true)
const targetSummary = summaries().find(row => row.collapsedTurns?.some(turn => turn.text === 'LRU-PROMPT-2'))
const target = targetSummary?.collapsedTurns?.find(turn => turn.text === 'LRU-PROMPT-2')
assert.ok(targetSummary && target, 'must seed seven independently evictable old chunks')
assert.ok(summaries().length >= 7, 'each heavy round must occupy its own chunk')
const COLS = 100, ROWS = 45
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const ttyFd = openSync(join(home, 'tty-output'), 'w')
let pendingWrites = 0
let parsedWrites = 0
let frames = 0
class Stdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true; fd = ttyFd
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) {
    pendingWrites++
    term.write(String(chunk), () => { pendingWrites--; parsedWrites++; done() })
  }
}
class Stdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdout = new Stdout(), stdin = new Stdin()
const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
const lines = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '')
const has = (s: string) => lines().some(line => line.includes(s))
type ProbeNode = {
  nodeName?: string
  nodeValue?: string
  childNodes?: ProbeNode[]
  scrollTop?: number
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  stickyScroll?: boolean
  yogaNode?: { getComputedTop(): number; getComputedHeight(): number }
}
const root = (): ProbeNode | undefined => (inkInstances.get(stdout as never) as unknown as { rootNode?: ProbeNode } | undefined)?.rootNode
const walk = (node: ProbeNode | undefined, visit: (node: ProbeNode) => void): void => {
  if (!node) return
  visit(node)
  for (const child of node.childNodes ?? []) walk(child, visit)
}
const textNode = (text: string): ProbeNode | undefined => {
  let result: ProbeNode | undefined
  walk(root(), node => { if (node.nodeValue?.includes(text)) result = node })
  return result
}
const pathToText = (text: string): ProbeNode[] | undefined => {
  const search = (node: ProbeNode | undefined, parents: ProbeNode[]): ProbeNode[] | undefined => {
    if (!node) return undefined
    const path = [...parents, node]
    if (node.nodeValue?.includes(text)) return path
    for (const child of node.childNodes ?? []) {
      const found = search(child, path)
      if (found) return found
    }
    return undefined
  }
  return search(root(), [])
}
// The LCA of the two code texts is Markdown's column; the four containing
// boxes are Markdown's host, the bullet row, AssistantTextMessage, then the
// settled TranscriptRow Box whose ref is registered with MessageList.
const assistantRowRef = (): ProbeNode => {
  const a = pathToText('A_BODY_2'), b = pathToText('B_HEAD_2')
  assert.ok(a && b, 'both blocks must have mounted DOM nodes')
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  const row = a[common - 1 - 4]
  assert.ok(row?.nodeName === 'ink-box', `expected TranscriptRow Box at the shared Markdown path: ${a.map(node => node.nodeName).join(' > ')}`)
  return row
}
const containsNode = (target: ProbeNode): boolean => {
  let found = false
  walk(root(), node => { if (node === target) found = true })
  return found
}
const geometry = () => {
  let scroll: ProbeNode | undefined
  walk(root(), node => { if (node.scrollViewportHeight !== undefined) scroll = node })
  return scroll && { top: scroll.scrollTop, height: scroll.scrollHeight, viewport: scroll.scrollViewportHeight, viewportTop: scroll.scrollViewportTop, sticky: scroll.stickyScroll }
}
const diagnostic = () => JSON.stringify({ frames, parsedWrites, pendingWrites, queuedBytes: stdout.writableLength, geometry: geometry(), mountedBody: textNode('A_BODY_2') !== undefined, summaries: summaries().map(row => row.id) })
// A sentinel queues behind every earlier stdout write. The write callback
// fires only after xterm's own parse callback, not merely after enqueueing.
const drain = async (): Promise<void> => {
  // Rendering may queue another write while the sentinel is being parsed.
  // Drain those too; otherwise the screen can still be partway through a
  // subsequent frame when the sentinel callback resolves.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve, reject) => stdout.write('', error => error ? reject(error) : resolve()))
    if (pendingWrites === 0 && stdout.writableLength === 0) return
  }
  assert.fail(`xterm output did not drain: ${diagnostic()}`)
}
const wait = async (name: string, predicate: () => boolean) => {
  assert.ok(await settled(() => pendingWrites === 0 && stdout.writableLength === 0 && predicate(), { timeoutMs: 15000 }), `${name}\n${diagnostic()}\n${lines().join('\n')}`)
  await drain()
  assert.ok(predicate(), `${name} after xterm drain\n${diagnostic()}\n${lines().join('\n')}`)
  console.log(`PASS: ${name}`)
}
const click = async (text: string) => {
  await wait(`mouse target ${text}`, () => has(text))
  const y = lines().findIndex(line => line.includes(text))
  const x = lines()[y]!.indexOf(text) + 1
  stdin.write(`\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`)
}
// Home edits the prompt; fullscreen Chat pages the transcript with PgUp.
// Wait for an actual new frame and viewport motion after every page, rather
// than guessing when scrolling/virtualization has converged.
const pageUpTo = async (present: () => boolean): Promise<void> => {
  for (let attempts = 0; attempts < 8 && !present(); attempts++) {
    const before = geometry()?.top
    assert.notEqual(before, undefined, `missing scroll geometry: ${diagnostic()}`)
    assert.ok(before! > 0, `target absent at transcript top\n${diagnostic()}\n${lines().join('\n')}`)
    const beforeFrame = frames
    stdin.write('\x1b[5~')
    await wait('PgUp paints actual transcript movement', () => frames > beforeFrame && ((geometry()?.top ?? before!) < before! || present()))
  }
  assert.ok(present(), `target must be reachable after bounded PgUp navigation\n${diagnostic()}\n${lines().join('\n')}`)
}
let app: Awaited<ReturnType<typeof render>> | undefined
let rerenderCommitFrame: number | undefined
const questionStore = new QuestionStore()
function RerenderProbe({ generation }: { generation: number }): React.ReactNode {
  React.useLayoutEffect(() => {
    if (generation === 1) rerenderCommitFrame = frames
  }, [generation])
  return <AlternateScreen><Chat channel={mount.channel as never} questionStore={questionStore} fullscreen trajectorySeen /></AlternateScreen>
}
const tree = (generation = 0) => <RerenderProbe generation={generation} />
try {
  // Direct channel projection is used for setup, not to toggle disclosure.
  mount.channel.revealRow(target.id)
  const assistant = mount.channel.rows.find(row => row.kind === 'assistant' && row.text.includes('A_HEAD_2'))
  assert.ok(assistant, 'target assistant must materialize')
  app = await render(tree(), {
    stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, patchConsole: false, exitOnCtrlC: false,
    onFrame: () => { frames++ },
  })
  await wait('initial Chat frame is ready', () => has('LRU-PROMPT-8'))
  await pageUpTo(() => has('A_HEAD_2') && has('B_HEAD_2'))
  await wait('target shows two independently folded blocks', () => has('A_HEAD_2') && has('B_HEAD_2') && !has('A_BODY_2') && !has('B_BODY_2'))
  await click('A_HEAD_2')
  await wait('SGR opens A only', () => has('A_BODY_2') && has('B_HEAD_2') && !has('B_BODY_2'))
  const oldRowRef = assistantRowRef()
  assert.ok(containsNode(oldRowRef), 'the original assistant row ref must actually be mounted')
  const beforeEvictionFrame = frames
  for (const summary of summaries().filter(row => row.id !== targetSummary.id)) mount.channel.revealRow(summary.id)
  assert.ok(summaries().some(row => row.id === targetSummary.id), 'target chunk must actually be evicted by the LRU')
  console.log('PASS: real channel LRU evicted target chunk')
  await wait('eviction paints a new frame and unmounts the original row ref', () => frames > beforeEvictionFrame && !containsNode(oldRowRef) && !has('A_BODY_2'))
  console.log(`EVICTED ${diagnostic()}`)
  const beforeRematerializeFrame = frames
  mount.channel.revealRow(target.id)
  assert.ok(mount.channel.rows.some(row => row.id === assistant.id && row.kind === 'assistant'), 'rematerialized row must keep its id')
  console.log('PASS: rematerialized row retains its id')
  await wait('rematerialization schedules a fresh frame', () => frames > beforeRematerializeFrame)
  await pageUpTo(() => (has('A_BODY_2') || has('A_HEAD_2')) && has('B_HEAD_2'))
  await wait('real LRU rematerialization keeps A open and B closed', () => textNode('A_BODY_2') !== undefined && has('A_BODY_2') && has('B_HEAD_2') && !has('B_BODY_2'))
  assert.notEqual(assistantRowRef(), oldRowRef, 'rematerialization must mount a new assistant row ref')
  console.log(`RESTORED ${diagnostic()}`)
  app.rerender(tree(1))
  await wait('independent React rerender commits and produces a later frame', () => rerenderCommitFrame !== undefined && frames > rerenderCommitFrame)
  assert.ok(has('A_BODY_2') && has('B_HEAD_2') && !has('B_BODY_2'), `rerender must preserve A open / B closed\n${diagnostic()}\n${lines().join('\n')}`)
  const ink = inkInstances.get(stdout as never)
  assert.ok(ink, 'the fake stdout must own an Ink instance')
  const beforeRedrawFrame = frames
  ink.forceRedraw()
  await wait('independent full redraw produces a new parsed frame', () => frames > beforeRedrawFrame)
  assert.ok(has('A_BODY_2') && has('B_HEAD_2') && !has('B_BODY_2'), `full redraw must preserve A open / B closed\n${diagnostic()}\n${lines().join('\n')}`)
  console.log(`REDRAWN ${diagnostic()}`)
  await sleep(200) // 固定窗:探针 no delayed layout update may undo the fresh redraw
  await drain()
  assert.ok(has('A_BODY_2') && has('B_HEAD_2') && !has('B_BODY_2'), `restored state must remain stable after redraw\n${diagnostic()}\n${lines().join('\n')}`)
  console.log(`PASS: restored state stays stable after redraw ${diagnostic()}`)
} finally {
  if (app) await app.unmount()
  await drain()
  mount.dispose(); unregister(); raw.releaseContributions()
  for (const cleanup of cleanups.reverse()) cleanup()
  term.dispose()
  closeSync(ttyFd)
  assert.ok(resolve(home).startsWith(resolve(prefix)))
  rmSync(home, { recursive: true, force: true })
}
