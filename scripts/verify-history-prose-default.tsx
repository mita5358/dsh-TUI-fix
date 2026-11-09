/**
 * Default historical prose through synthetic DSH events -> createChannel ->
 * mountChannelUi -> fullscreen Chat -> headless xterm. No real session or
 * credentials; HOME and DSH/XDG homes are temporary. No reveal, hover, rail
 * click or Ctrl+O: only normal PageUp/End and wheel scrolling. Before rendering and again
 * before input, check real transcript rows, never collapsedTurns metadata.
 * Twelve turns each have a prompt and ten answer lines (>120 logical lines);
 * this does NOT exercise MessageList's separate 120 projected-row cap. Large
 * tool arguments force old chunks without flooding the visible viewport.
 * Run: node --import tsx/esm scripts/verify-history-prose-default.tsx
 */
import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, mkdirSync, openSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

const tempRoot = realpathSync(tmpdir())
const scratch = mkdtempSync(join(tempRoot, 'dsh-history-prose-'))
const envKeys = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'FORCE_COLOR']
const previous = new Map([...Object.entries(process.env).filter(([key]) => key.startsWith('DSH_')), ...envKeys.map(key => [key, process.env[key]] as const)])
for (const key of Object.keys(process.env)) if (key.startsWith('DSH_')) delete process.env[key]
process.env.HOME = join(scratch, 'home')
process.env.USERPROFILE = process.env.HOME
process.env.DSH_HOME = join(scratch, 'dsh-home')
process.env.XDG_CONFIG_HOME = join(scratch, 'config')
process.env.XDG_CACHE_HOME = join(scratch, 'cache')
process.env.XDG_DATA_HOME = join(scratch, 'data')
process.env.XDG_STATE_HOME = join(scratch, 'state')
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
mkdirSync(process.env.HOME, { recursive: true })
let ttyFd: number | undefined

try {
  ttyFd = openSync(join(scratch, 'tty-output'), 'w')
  const [React, { Terminal }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel }, { mountChannelUi }, { registerTuiChannel }, { bindChannelCommands }, { settled, sleep }, { default: inkInstances }, { createDshTranslator }, { planChunks }] = await Promise.all([
    import('react'), import('@xterm/headless'), import('../src/ui.js'), import('../src/screens/Chat.js'),
    import('../src/dsh-adapter/questions.js'), import('../src/dsh-adapter/channel.js'),
    import('../src/dsh-adapter/channel-ui.js'), import('../src/adapter/channel/host-registry.js'),
    import('../src/dsh-adapter/channel/commands.js'), import('./lib/term-test.mjs'), import('../src/ink/instances.js'),
    import('../src/dsh-adapter/backend/translate.js'), import('../src/dsh-adapter/backend/history-chunks.js'),
  ])
  type RawEvent = { type: string; seq: number; time: number; data: Record<string, unknown> }
  const events: RawEvent[] = []
  const append = (type: string, data: Record<string, unknown>): void => {
    events.push({ type, seq: events.length + 1, time: events.length + 1, data })
  }
  const prompt = (n: number) => `PROSE-PROMPT-${n}-complete question`
  const answerLine = (n: number, line: number) => `PROSE-ANSWER-${n}-line-${String(line).padStart(2, '0')}-complete`
  const answer = (n: number) => Array.from({ length: 10 }, (_, i) => answerLine(n, i + 1)).join('\n')
  for (let n = 1; n <= 12; n += 1) {
    append('user/message', { id: `user-${n}`, source: { kind: 'user' }, content: [{ type: 'text', text: prompt(n) }] })
    if (n < 12) append('tool/call', { turn: n, step: 1, callId: `large-${n}`, name: 'ask_user_question', arguments: JSON.stringify({ unused: 'x'.repeat(300_000) }) })
    append('assistant/message', { turn: n, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer(n) }] } })
  }
  const callbacks = new Map<string, Set<(...args: unknown[]) => unknown>>()
  const cleanups: (() => void)[] = []
  const agent = { id: 'history-prose', status: 'idle', session: { id: 'synthetic-session', seq: events.length, events, header: { cwd: scratch } }, ctx: { on: () => () => undefined }, followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true } }
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
  bindChannelCommands(raw, mount.channel)
  const COLS = 100
  const ROWS = 40
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  let pendingFrames = 0
  let parsedFrames = 0
  let observeFrame: () => void = () => undefined
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    fd = ttyFd
    _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) {
      pendingFrames += 1
      term.write(String(chunk), () => { pendingFrames -= 1; parsedFrames += 1; observeFrame(); done() })
    }
  }
  class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
  const screen = (): string[] => Array.from({ length: ROWS }, (_, i) => term.buffer.active.getLine(term.buffer.active.baseY + i)?.translateToString(true) ?? '')
  type ProbeNode = { childNodes?: ProbeNode[]; scrollTop?: number; scrollHeight?: number; scrollViewportHeight?: number; scrollViewportTop?: number }
  const scrollNode = (): ProbeNode | undefined => {
    const root = (inkInstances.get(stdout as never) as unknown as { rootNode?: ProbeNode } | undefined)?.rootNode
    const walk = (node: ProbeNode): ProbeNode | undefined => {
      if (node.scrollViewportHeight !== undefined) return node
      for (const child of node.childNodes ?? []) { const found = walk(child); if (found) return found }
      return undefined
    }
    return root && walk(root)
  }
  let passed = 0
  let failed = 0
  const check = (name: string, ok: boolean): void => {
    if (ok) { passed += 1; console.log(`PASS: ${name}`) }
    else { failed += 1; console.error(`FAIL: ${name}`) }
  }
  const targets = [1, 6, 11, 12]
  // Default window = the newest chunk (OPEN_ROUNDS/OPEN_CHARS in
  // docs/dynamic-history-loading.md): its turns must be present as full prompt
  // + full answer rows; older turns must be either equally full (already
  // materialized) or covered by a collapsed digest row — never silently
  // missing. Every round here carries ~300 KB of tool arguments, so the char
  // budget (not the round count) decides the window; take it from the plan.
  let openWindow: [number, number] = [1, 0]
  const checkRows = (stage: string): void => {
    const rows = mount.channel.rows
    for (const n of targets) {
      const userIndex = rows.findIndex(row => row.kind === 'user' && row.text === prompt(n))
      const answerIndex = rows.findIndex(row => row.kind === 'assistant' && row.text === answer(n))
      const full = userIndex >= 0 && answerIndex > userIndex
      if (n >= openWindow[0] && n <= openWindow[1]) {
        check(`${stage}: turn ${n} has full prompt then full answer in transcript rows`, full)
        continue
      }
      const digest = rows.findIndex(row => row.collapsed === true && (row.collapsedTurns ?? []).some(turn => turn.text === prompt(n)))
      check(`${stage}: older turn ${n} is loaded in full or behind a collapsed digest row`, full || digest >= 0)
    }
  }
  let app: Awaited<ReturnType<typeof render>> | undefined
  try {
    check('fixture contains >120 logical prompt/answer lines', 12 * 11 > 120)
    const translator = createDshTranslator({ tools: () => undefined, scope: () => undefined, attachments: () => undefined })
    const chunks = planChunks(translator.translateReplay(events as never, { present: false }))
    check('translated fixture plans multiple old chunks', chunks.length >= 3)
    const newest = chunks[chunks.length - 1]!
    openWindow = [newest.fromRound, newest.toRound]
    check('the newest chunk opens a real window of rounds', newest.fromRound >= 1 && newest.toRound >= newest.fromRound)
    checkRows('before render, before interaction')
    app = await render(<AlternateScreen><Chat channel={mount.channel} questionStore={new QuestionStore()} fullscreen trajectorySeen /></AlternateScreen>, { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, patchConsole: false, exitOnCtrlC: false })
    check('initial xterm screen and scrolling viewport are ready', await settled(() => scrollNode() !== undefined && screen().some(line => line.trim() !== ''), { timeoutMs: 20000 }))
    checkRows('after render, before interaction')
    const rowPairs = (): number[] => targets.filter(n => {
      const rows = mount.channel.rows
      const userIndex = rows.findIndex(row => row.kind === 'user' && row.text === prompt(n))
      return userIndex >= 0 && rows.findIndex(row => row.kind === 'assistant' && row.text === answer(n)) > userIndex
    })
    const preInput = rowPairs()
    console.log(`PRE_INPUT transcript_pairs=${preInput.join(',')}`)
    const found = new Set<number>()
    const foundAfterInput = new Set<number>()
    const firstMaterialized = new Map<number, string>()
    let navigation = 'End'
    const capture = (): void => {
      for (const n of rowPairs()) if (!preInput.includes(n) && !firstMaterialized.has(n)) firstMaterialized.set(n, navigation)
      const lines = screen()
      for (const n of targets) {
        const indexes = [prompt(n), ...Array.from({ length: 10 }, (_, i) => answerLine(n, i + 1))].map(text => lines.findIndex(line => line.includes(text)))
        if (indexes.every((index, i) => index >= 0 && (i === 0 || index > indexes[i - 1]!))) {
          found.add(n)
          if (!preInput.includes(n)) foundAfterInput.add(n)
        }
      }
    }
    // Each callback follows xterm's asynchronous parse of a complete stdout
    // write. Retain successful actual frames, not just the last frame after a
    // chunk has materialized and potentially moved the viewport again.
    observeFrame = capture
    // End is ordinary scrolling, not a reveal: start at the actual tail.
    stdin.write('\x1b[F')
    check('End reaches newest prompt before the upward walk', await settled(() => screen().some(line => line.includes(prompt(12)))))
    await settled(() => screen().some(line => line.includes(answerLine(12, 10))) && pendingFrames === 0, { timeoutMs: 1500 })
    capture()
    let moves = 0
    navigation = 'PageUp'
    const pageStart = scrollNode()?.scrollTop
    const pageFrame = parsedFrames
    stdin.write('\x1b[5~')
    const pageMoved = await settled(() => pageStart !== undefined && (scrollNode()?.scrollTop ?? pageStart) < pageStart, { timeoutMs: 3000, stepMs: 5 })
    const pageParsed = await settled(() => parsedFrames > pageFrame, { timeoutMs: 3000, stepMs: 5 })
    if (pageMoved && pageParsed) moves += 1
    console.log(`PAGE_UP start=${pageStart} observedUp=${pageMoved} parsedFrame=${pageParsed} top=${scrollNode()?.scrollTop}`)
    // 固定窗:墙钟 MessageList load-on-sight waits 120ms after a section
    // enters view; allow that production timer and the resulting frame to land.
    await sleep(180)
    await settled(() => pendingFrames === 0 && stdout.writableLength === 0)
    capture()
    // PageUp through the oldest reachable position; then wheel downward in
    // three-line steps, so a full short turn cannot be skipped by paging.
    for (let i = 0; i < 30; i += 1) {
      const before = scrollNode()?.scrollTop
      if (before === undefined || before <= 0) break
      const frames = parsedFrames
      stdin.write('\x1b[5~')
      const moved = await settled(() => (scrollNode()?.scrollTop ?? before) < before, { timeoutMs: 1000, stepMs: 5 })
      if (moved && await settled(() => parsedFrames > frames, { timeoutMs: 1000, stepMs: 5 })) moves += 1
      await sleep(180) // 固定窗:墙钟 allow the production load-on-sight debounce to settle
      await settled(() => pendingFrames === 0 && stdout.writableLength === 0)
      capture()
      if (!moved) break
    }
    navigation = 'wheel-down'
    let wheelMoves = 0
    for (let i = 0; i < 180 && !targets.every(n => found.has(n)); i += 1) {
      const node = scrollNode()
      const before = node?.scrollTop
      if (before === undefined || node?.scrollViewportHeight === undefined || node.scrollViewportTop === undefined) break
      const max = Math.max(0, (node.scrollHeight ?? 0) - node.scrollViewportHeight)
      if (before >= max) break
      const y = Math.max(1, Math.min(ROWS, node.scrollViewportTop + Math.floor(node.scrollViewportHeight / 2) + 1))
      const frames = parsedFrames
      stdin.write(`\x1b[<65;50;${y}M`)
      const moved = await settled(() => (scrollNode()?.scrollTop ?? before) > before, { timeoutMs: 1000, stepMs: 5 })
      if (moved && await settled(() => parsedFrames > frames, { timeoutMs: 1000, stepMs: 5 })) { moves += 1; wheelMoves += 1 }
      await sleep(180) // 固定窗:墙钟 allow the production load-on-sight debounce to settle
      await settled(() => pendingFrames === 0 && stdout.writableLength === 0)
      capture()
      if (!moved) break
    }
    observeFrame = () => undefined
    console.log(`SCROLL moves=${moves} wheelMoves=${wheelMoves} finalTop=${scrollNode()?.scrollTop} found=${[...found].join(',')} post_input_materialized=${JSON.stringify(Object.fromEntries(firstMaterialized))} screen_after_input_only=${[...foundAfterInput].join(',')}`)
    check('ordinary upward scrolling changes the viewport', pageMoved && pageParsed)
    for (const n of targets) check(`ordinary scrolling paints full turn ${n} in correct screen order`, found.has(n))
    if (failed) console.error(`FINAL SCREEN:\n${screen().join('\n')}`)
    console.log(`HISTORY PROSE ${failed ? 'FAILED' : 'OK'} (${passed} passed, ${failed} failed)`)
  } finally {
    if (app) await app.unmount()
    mount.dispose()
    unregister()
    raw.releaseContributions()
    for (const cleanup of cleanups.reverse()) cleanup()
    term.dispose()
  }
  if (failed) process.exitCode = 1
} finally {
  if (ttyFd !== undefined) closeSync(ttyFd)
  for (const key of Object.keys(process.env)) if (key.startsWith('DSH_')) delete process.env[key]
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  const actual = realpathSync(scratch)
  assert.equal(dirname(actual), tempRoot, 'refuse cleanup outside real temporary root')
  assert.ok(basename(actual).startsWith('dsh-history-prose-'), 'refuse cleanup of unowned path')
  assert.equal(actual, scratch, 'refuse cleanup of replaced or redirected path')
  rmSync(actual, { recursive: true, force: true })
}
