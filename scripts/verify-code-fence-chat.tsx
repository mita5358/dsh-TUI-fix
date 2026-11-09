/** Real Chat + headless xterm SGR fence disclosure regression. No real backend.
 * Run: node --import tsx/esm scripts/verify-code-fence-chat.tsx
 */
import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

// Never inherit harness trace/session paths or a temporary root pointing at
// user data. Every DSH/XDG path below belongs to this synthetic fixture.
for (const key of Object.keys(process.env)) if (key.startsWith('DSH_') || key.startsWith('XDG_')) delete process.env[key]
delete process.env.TMPDIR
delete process.env.TMP
delete process.env.TEMP
const tempRoot = realpathSync(tmpdir())
const home = realpathSync(mkdtempSync(join(tempRoot, 'code-fence-chat-')))
let cleaned = false
const cleanupHome = (): void => {
  if (cleaned) return
  // Re-resolve immediately before deletion, and reject any replaced path.
  const actual = realpathSync(home)
  assert.equal(actual, home, 'refuse to clean a replaced fixture path')
  assert.equal(dirname(actual), tempRoot, 'refuse to clean outside the temporary root')
  assert.ok(basename(actual).startsWith('code-fence-chat-'), 'refuse to clean a non-fixture directory')
  rmSync(actual, { recursive: true, force: true })
  cleaned = true
}
// Covers import/setup failures too; the normal finally cleans up first.
process.once('exit', cleanupHome)
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, '.dsh')
process.env.XDG_CONFIG_HOME = join(home, '.config')
process.env.XDG_CACHE_HOME = join(home, '.cache')
process.env.XDG_DATA_HOME = join(home, '.local', 'share')
process.env.XDG_STATE_HOME = join(home, '.local', 'state')
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
const [React, { Terminal }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS }, { settled, sleep }, { default: inkInstances }] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'), import('./lib/term-test.mjs'), import('../src/ink/instances.js'),
])
const COLS = 100, ROWS = 45
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
const ttyFd = openSync(join(home, 'tty-output'), 'w')
let pendingWrites = 0
let parsedWrites = 0
let frames = 0
let requiredFrame = -1
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
const body = ['INTRO', '```js', 'BLOCK_A_HEAD', 'BLOCK_A_BODY', '```', '~~~mermaid', 'graph LR', 'MERM_START-->MERM_END', '~~~'].join('\n')
const listeners = new Set<() => void>()
const channel = {
  version: 0, rows: [{ id: 1, kind: 'assistant', text: body, streaming: false }],
  agentId: 'agent-a', sessionId: 'session-a', whaleIdle: false,
  status: 'idle', sessionTitle: 'fixture', model: 'model', provider: 'fixture',
  tokens: { input: 0, output: 0 }, cwd: home, displayCwd: home, gitBranch: '',
  working: false, spinnerMode: 'requesting', mode: { plan: false }, responseChars: 0,
  activeToolCount: 0, turnStart: 0, lastUserText: '', pending: [],
  commandList: LOCAL_COMMANDS, commandCompletions: () => [], notifications: [],
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn) },
  submit() {}, steer() {}, cancel() {}, clear() { this.rows = []; this.emit() }, notify() {},
  listModels: async () => [], listSessions: () => [], setResumeTarget() {},
  emit() { requiredFrame = frames; this.version++; for (const fn of listeners) fn() },
}
const lines = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '')
const has = (s: string) => lines().some(line => line.includes(s))
const diagnostics = () => JSON.stringify({ frames, requiredFrame, pendingWrites, parsedWrites, queuedBytes: stdout.writableLength })
const writeInput = (input: string): void => { requiredFrame = frames; stdin.write(input) }
const drain = async (): Promise<void> => {
  // The sentinel queues after prior writes; another frame may be queued
  // during parsing, so repeat until the writable and xterm are both idle.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve, reject) => stdout.write('', error => error ? reject(error) : resolve()))
    if (pendingWrites === 0 && stdout.writableLength === 0) return
  }
  assert.fail(`xterm output did not drain: ${diagnostics()}`)
}
const waitScreen = async (name: string, predicate: () => boolean): Promise<void> => {
  assert.ok(await settled(() => frames > requiredFrame && pendingWrites === 0 && stdout.writableLength === 0 && predicate(), { timeoutMs: 15000 }), `${name}\n${diagnostics()}\n${lines().join('\n')}`)
  await drain()
  assert.ok(predicate(), `${name} after xterm drain\n${diagnostics()}\n${lines().join('\n')}`)
}
const click = async (s: string) => {
  await waitScreen(`missing click target ${s}`, () => has(s))
  const y = lines().findIndex(line => line.includes(s))
  const x = lines()[y]!.indexOf(s) + 1
  writeInput(`\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`)
}
const check = async (name: string, predicate: () => boolean) => {
  await waitScreen(name, predicate)
  console.log(`PASS: ${name}`)
}
let app: Awaited<ReturnType<typeof render>> | undefined
try {
  app = await render(<AlternateScreen><Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen trajectorySeen /></AlternateScreen>, {
    stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, patchConsole: false, exitOnCtrlC: false,
    onFrame: () => { frames++ },
  })
  await check('ordinary and Mermaid fences start folded', () => has('BLOCK_A_HEAD') && has('⌁ mermaid') && !has('BLOCK_A_BODY') && !has('MERM_END'))
  await drain()
  const dragRow = lines().findIndex(line => line.includes('BLOCK_A_HEAD')) + 1
  const dragCol = lines()[dragRow - 1]!.indexOf('BLOCK_A_HEAD') + 1
  writeInput(`\x1b[<0;${dragCol};${dragRow}M\x1b[<32;${dragCol + 5};${dragRow}M\x1b[<0;${dragCol + 5};${dragRow}m`)
  await waitScreen('selection drag reaches a fresh parsed frame', () => true)
  await sleep(250) // 固定窗:探针 selection drag must not dispatch a delayed click
  await drain()
  assert.ok(!has('BLOCK_A_BODY') && has('⌁ mermaid'), 'selection drag must not open a fence')
  console.log('PASS: selection drag does not toggle a fence')
  writeInput('\x1b') // clear selection before the click
  await sleep(600) // 固定窗:墙钟 mouse double-click recognition window
  await click('BLOCK_A_HEAD')
  await check('open A without opening Mermaid', () => has('BLOCK_A_BODY') && has('⌁ mermaid') && !has('MERM_END'))
  writeInput('\x0c')
  // Chat's Ctrl+L lookup uses process.stdout, not the isolated fake stream.
  // Force its own Ink instance to redraw so this assertion observes a real
  // new frame rather than claiming the unchanged old buffer is a redraw.
  const ink = inkInstances.get(stdout as never)
  assert.ok(ink, 'fake stdout must own an Ink instance')
  ink.forceRedraw()
  await check('redraw preserves individual state', () => has('BLOCK_A_BODY') && has('⌁ mermaid'))
  writeInput('\x0f')
  await check('Ctrl+O temporarily opens both from A-open B-closed', () => has('BLOCK_A_BODY') && !has('⌁ mermaid') && (has('MERM_START') || has('graph LR')))
  await sleep(600) // 固定窗:墙钟 mouse double-click recognition window
  await drain()
  await click(has('MERM_START') ? 'MERM_START' : 'graph LR')
  await check('global mode can close B without changing A', () => has('BLOCK_A_BODY') && has('⌁ mermaid'))
  writeInput('\x0f')
  await check('leaving global mode restores A-open B-closed', () => has('BLOCK_A_BODY') && has('⌁ mermaid'))
  // Consecutive clicks at a nearby location are interpreted as double-clicks.
  await sleep(600) // 固定窗:墙钟 mouse double-click recognition window
  await click('⌁ mermaid')
  await check('Mermaid expands independently', () => has('BLOCK_A_BODY') && !has('⌁ mermaid') && (has('MERM_START') || has('graph LR')))
  await sleep(600) // 固定窗:墙钟 mouse double-click recognition window
  await click('BLOCK_A_BODY')
  await check('closing A keeps Mermaid expanded', () => !has('BLOCK_A_BODY') && has('BLOCK_A_HEAD') && !has('⌁ mermaid'))
  writeInput('\x0f')
  await check('Ctrl+O expands both', () => has('BLOCK_A_BODY') && !has('⌁ mermaid'))
  writeInput('\x0f')
  await check('Ctrl+O restores individual states', () => !has('BLOCK_A_BODY') && !has('⌁ mermaid'))
  channel.rows = []; channel.emit()
  await check('row is actually unmounted', () => !has('BLOCK_A_HEAD'))
  channel.rows = [{ id: 1, kind: 'assistant', text: body, streaming: false }]; channel.emit()
  await check('remount preserves the open Mermaid path', () => has('BLOCK_A_HEAD') && !has('BLOCK_A_BODY') && !has('⌁ mermaid'))
  writeInput('/clear')
  await check('clear command reaches composer', () => has('/clear'))
  writeInput('\r')
  await check('/clear removes old rows', () => !has('BLOCK_A_HEAD'))
  channel.rows = [{ id: 1, kind: 'assistant', text: body, streaming: false }]; channel.emit()
  await check('/clear prevents row-id reuse from inheriting disclosure', () => has('⌁ mermaid') && !has('BLOCK_A_BODY'))
  await sleep(600) // 固定窗:墙钟 mouse double-click recognition window
  await click('⌁ mermaid')
  await check('open a fence before session switch', () => !has('⌁ mermaid') && (has('MERM_START') || has('graph LR')))
  channel.agentId = 'agent-b'; channel.sessionId = 'session-b'; channel.emit()
  await check('new session with reused row id has no old disclosure', () => has('⌁ mermaid') && !has('BLOCK_A_BODY'))
  channel.rows = [{ id: 1, kind: 'assistant', text: body, streaming: true }]; channel.emit()
  await check('streaming fences are not folded', () => has('BLOCK_A_BODY') && !has('⌁ mermaid'))
  const longCode = `LONG_CODE_HEAD${'x'.repeat(1200)}LONG_CODE_TAIL`
  channel.rows = [{ id: 1, kind: 'assistant', text: `PLAIN_PROSE\n\n\`\`\`text\n${longCode}\n\`\`\`\n\n~~~py\nOTHER_CODE_BODY\n~~~`, streaming: false }]; channel.emit()
  await check('long fence alone does not fold surrounding prose', () => has('PLAIN_PROSE') && has('⌁ text') && has('⌁ py'))
  await sleep(600) // 固定窗:墙钟 mouse double-click recognition window
  await click('PLAIN_PROSE')
  await sleep(250) // 固定窗:探针 prose click must not unfold either fence
  await drain()
  assert.ok(has('⌁ text') && has('⌁ py') && !has('LONG_CODE_TAIL'), `ordinary prose click must not toggle fences\n${lines().join('\n')}`)
  console.log('PASS: ordinary prose click does not unfold long fence or sibling')
  const longProse = `LONG_PROSE_HEAD${'p'.repeat(1200)}LONG_PROSE_TAIL`
  channel.rows = [{ id: 1, kind: 'assistant', text: `${longProse}\n\n\`\`\`text\n${longCode}\n\`\`\``, streaming: false }]; channel.emit()
  await check('long prose retains its independent fold', () => has('chars folded') && has('⌁ text') && !has('LONG_PROSE_TAIL'))
  await sleep(600) // 固定窗:墙钟 mouse double-click recognition window
  await click('⌁ text')
  await check('long code opens to its real tail without opening parent prose', () => has('LONG_CODE_TAIL') && has('chars folded') && !has('LONG_PROSE_TAIL'))
  channel.rows = [{ id: 1, kind: 'assistant', text: `${'s'.repeat(1200)}STREAM_LONG_TAIL`, streaming: true }]; channel.emit()
  await check('streaming long line is not clipped', () => has('STREAM_LONG_TAIL') && !has('chars folded'))
} finally {
  try {
    if (app) await app.unmount()
    await drain()
  } finally {
    term.dispose()
    closeSync(ttyFd)
    cleanupHome()
  }
}
