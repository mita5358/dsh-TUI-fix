/**
 * Bounded synthetic regression: actual fullscreen Chat -> MessageList ->
 * StreamingMarkdown -> terminal paint, with a headless xterm viewport.
 * No real backend, session, credentials, process inspection, or network.
 *
 * Diagnostic probe, NOT a release gate: it stays red until the streaming
 * suffix budget can be made lossless, and a gate that always fails is noise in
 * verify:build. Run it by hand:
 *   node scripts/run-streaming-unfolded.mjs
 *
 * A nonzero exit is a real failure, including a missed screen/navigation
 * prerequisite. Historical clipSuffixTail budget 3584 + 1024 clips the head
 * of the >6000-character single paragraph; that must be reported as red, not
 * reclassified as a pass just because the source still contains the head.
 * Code fences render their opening delimiter as a language-labelled frame;
 * the language label, not literal backticks, is the observable start marker.
 */
import { closeSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// The wrapper forwards fd 3 and drains fd 1 separately; reopening /dev/stdout
// fails for socket-backed harness output. Ink never receives the reporter fd.
const reportFd = 3
const report = (line: string): void => { writeSync(reportFd, `${line}\n`) }
const tempParent = realpathSync(tmpdir())
const temp = mkdtempSync(join(tempParent, 'dsh-stream-unfolded-'))
const tempReal = realpathSync(temp)
if (dirname(tempReal) !== tempParent || !basename(tempReal).startsWith('dsh-stream-unfolded-')) {
  throw new Error('refusing unsafe temporary directory')
}
let cleaned = false
function cleanup(): void {
  if (cleaned) return
  cleaned = true
  // Never follow a replaced symlink or delete any path other than our own dir.
  try {
    if (!lstatSync(temp).isDirectory() || realpathSync(temp) !== tempReal || dirname(tempReal) !== tempParent) {
      throw new Error('temporary directory identity changed; refusing cleanup')
    }
    rmSync(temp, { recursive: true })
  } catch (error) {
    report(`CLEANUP FAILURE: ${String(error)}`)
    process.exitCode = 1
  }
}
process.once('SIGTERM', () => { cleanup(); process.exit(143) })
process.once('SIGINT', () => { cleanup(); process.exit(130) })

// Keep only OS process-launch paths, then give every home/config/cache path a
// private root. No inherited session settings or credentials reach imports.
const osEnv = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']
  .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, osEnv, {
  HOME: temp, USERPROFILE: temp, TMPDIR: temp, TMP: temp, TEMP: temp,
  XDG_CONFIG_HOME: join(temp, 'config'), XDG_CACHE_HOME: join(temp, 'cache'),
  XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state'),
  DSH_HOME: join(temp, 'dsh'), DSH_TUI_HOME: join(temp, 'tui'),
  DSH_TUI_LANG: 'en', DSH_TUI_THEME: 'dark', FORCE_COLOR: '3',
  TERM: 'xterm-256color', NODE_ENV: 'production',
})

let failures = 0
try {
  const [{ PassThrough, Writable }, React, { Terminal }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS, completeCommands }, { settled, viewportLines }] = await Promise.all([
    import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'),
    import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'),
    import('../src/commands.js'), import('./lib/term-test.mjs'),
  ])
  const COLS = 100, ROWS = 32
  const check = (name: string, ok: boolean, detail = ''): void => {
    report(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
    if (!ok) failures++
  }
  const pack = (screen: string): string => screen.replace(/\s+/g, '')
  const has = (screen: string, text: string): boolean => pack(screen).includes(pack(text))
  const folded = (screen: string): boolean => /charsfolded(?:whilestreaming|\(clickor)/i.test(pack(screen))
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

  async function scenario(name: string, source: string, head: string, tail: string, language?: string): Promise<void> {
    const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
    const frames: string[] = []
    class Stdout extends Writable {
      columns = COLS; rows = ROWS; isTTY = true
      override _write(chunk: unknown, _encoding: BufferEncoding, done: () => void): void {
        term.write(String(chunk), () => { frames.push(viewportLines(term).join('\n')); done() })
      }
    }
    class Stdin extends PassThrough {
      isTTY = true
      setRawMode(): this { return this }
      override ref(): this { return this }
      override unref(): this { return this }
    }
    const stdout = new Stdout(), stdin = new Stdin()
    const stderr = new Writable({ write(_chunk, _encoding, done) { done() } })
    const listeners = new Set<() => void>()
    const row = { id: 2, kind: 'assistant', text: source.slice(0, 120), streaming: true }
    const channel = {
      whaleIdle: false, version: 0,
      rows: [{ id: 1, kind: 'user', text: 'SYNTHETIC REQUEST' }, row],
      status: 'idle', sessionTitle: 'synthetic', agentId: 'synthetic',
      model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [],
      tokens: { input: 0, output: 0 }, cwd: temp, displayCwd: temp, gitBranch: '',
      working: true, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0,
      turnStart: 0, pending: [], commandList: LOCAL_COMMANDS, notifications: [],
      mode: { plan: false, sandbox: undefined }, activityFrames: 'moon8', subagents: [],
      subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
      submit() {}, cancel() {}, clear() {}, notify() {}, listModels: async () => [],
      listSessions: async () => [], setResumeTarget() {}, loadOlder() {}, mcpStatus: () => [],
      pushLocal() {}, commandCompletions: (input: string) => completeCommands(input),
    }
    const screen = (): string => viewportLines(term).join('\n')
    let instance: Awaited<ReturnType<typeof render>> | undefined
    try {
      instance = await render(<AlternateScreen><Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen /></AlternateScreen>, {
        stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stderr as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
      })
      const initial = await settled(() => has(screen(), head), { timeoutMs: 6000 })
      check(`${name} initial streaming paint`, initial)
      // Append rather than simply mounting a completed string. The row remains streaming.
      const before = frames.length
      row.text = source
      channel.responseChars = source.length
      channel.version++
      for (const listener of listeners) listener()
      const finalReady = await settled(() => frames.length > before && has(screen(), tail), { timeoutMs: 6000 })
      check(`${name} streaming growth painted suffix`, finalReady, `chars=${source.length}`)
      // PageUp/PageDown are real Chat input. Inspect parsed xterm screen only.
      // A page is less than one viewport, so no screen row is skipped. A bounded
      // 16-page traversal covers both 6.6k fixtures even at 100x32.
      let sawHead = has(screen(), head)
      let sawLanguage = language === undefined || (sawHead && has(screen(), `┌─ ${language}`))
      for (let i = 0; i < 16 && (!sawHead || !sawLanguage); i++) {
        stdin.write('\x1b[5~')
        await sleep(120) // 固定窗:pacing page input and throttled renderer must drain before next page
        sawHead ||= has(screen(), head)
        sawLanguage ||= language !== undefined && has(screen(), head) && has(screen(), `┌─ ${language}`)
      }
      if (source.length > 6000) check(`${name} PageUp reaches transcript start`,
        has(screen(), 'SYNTHETIC REQUEST') && !has(screen(), tail),
        `request=${has(screen(), 'SYNTHETIC REQUEST')} tail=${has(screen(), tail)}`)
      check(`${name} PageUp reaches complete painted prefix`, sawHead)
      if (language !== undefined) check(`${name} opening fence paints language frame with prefix`, sawLanguage, `language=${language}`)
      let sawTail = has(screen(), tail)
      for (let i = 0; i < 16 && !sawTail; i++) {
        stdin.write('\x1b[6~')
        await sleep(120) // 固定窗:pacing page input and throttled renderer must drain before next page
        sawTail ||= has(screen(), tail)
      }
      check(`${name} PageDown reaches complete painted suffix`, sawTail,
        sawHead ? '' : 'prefix prerequisite failed; suffix checked independently')
      // Frames come from xterm's write callback, not raw ANSI or DOM/source.
      const foldFrame = frames.find(folded)
      check(`${name} no streaming-folded or long-line marker in traversed screens`, !foldFrame,
        foldFrame ? pack(foldFrame).match(/.{0,25}charsfolded.{0,75}/i)?.[0] ?? 'fold marker' : `parsed frames=${frames.length}`)
    } catch (error) {
      check(`${name} harness`, false, error instanceof Error ? error.stack ?? error.message : String(error))
    } finally {
      if (instance) await instance.unmount()
      term.dispose()
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
    }
  }

  const plain = (length: number, head: string, tail: string): string => head + 'x'.repeat(length - head.length - tail.length) + tail
  await scenario('plain-1200-control', plain(1200, 'CONTROLHEADuniqueABC', 'CONTROLTAILuniqueXYZ'), 'CONTROLHEADuniqueABC', 'CONTROLTAILuniqueXYZ')
  await scenario('plain-6600', plain(6600, 'PLAINHEADuniqueABC', 'PLAINTAILuniqueXYZ'), 'PLAINHEADuniqueABC', 'PLAINTAILuniqueXYZ')
  const fenceHead = 'FENCEHEADuniqueABC', fenceTail = 'FENCETAILuniqueXYZ'
  const fence = '```plaintext\n' + fenceHead + '\n' + Array.from({ length: 100 }, (_, i) => `line${String(i).padStart(3, '0')}${'z'.repeat(60)}`).join('\n') + '\n' + fenceTail
  await scenario('unclosed-fence-over-6000', fence, fenceHead, fenceTail, 'plaintext')
  report(`RESULT: ${failures} failed checks`)
  if (failures) process.exitCode = 1
} catch (error) {
  report(`HARNESS FAILURE: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  cleanup()
  closeSync(reportFd)
}
