/**
 * Isolated input latency probe: `NODE_ENV=production node --import tsx/esm scripts/perf-input-latency.tsx`
 * Optional synthetic Chat history: `NODE_ENV=production BENCH_CHAT=1 node --import tsx/esm scripts/perf-input-latency.tsx`
 * `BENCH_CHAT_BUSY=1` runs matched idle and simulated-streaming Chat fixtures.
 * `BENCH_DSH_CHANNEL=1` uses real DSH channel/router with synthetic agents and
 * events. BENCH_CPU_PROFILE=1 adds in-process CPU sampling during each real
 * channel input window only; no inspector server or profile file is opened.
 * Env: DRAFT_SIZES=0,1000,5000 (unit repeat counts), DRAFT_UNIT=a,
 * CHAT_TURNS=0,120,800 REAL_CHANNEL_TURNS=0 KEYS=20 (1..50),
 * REAL_SMOOTH_STREAMING=1 (0 or 1, matching production's default), and
 * BUSY_INTERVAL_MS=16 (positive integer, nominal interval; timers may slip).
 * Real channel accepts one history size per process and cannot share a process
 * with mock Chat fixtures: reveal cursors are module-global and key on row id.
 * For comparisons launch separate processes and set the smooth flag explicitly.
 *
 * Measures a real PromptInput or Chat and headless xterm (100x40), not a real
 * terminal, backend, IME, network, streaming transcript, or physical display.
 * Component drafts are controller-injected, UNFOLDED, and single-line; the
 * default unit is ASCII 'a', or set DRAFT_UNIT for synthetic Unicode. Each
 * seed reports the unit, repeat count and UTF-16 length, never the full draft.
 * This is not the default folded-paste path. Chat uses synthetic static mock rows,
 * not restored DSH chunks. The busy fixture appends synthetic text to one
 * assistant row and emits mock channel versions; it does not model network,
 * backend projection, tool activity or real user data. The DSH fixture uses
 * real createChannel/registerTuiChannel/mountChannelUi with an in-memory fake
 * host and injects 0.1.5+ agent/assistant-stream frames, but no real account,
 * persistence, network, agent, tool or model runs. It counts ingress separately
 * from real emitStream calls and an added UI subscriber; notifications can
 * include synchronous session events and other emits, not only stream wakes.
 * Every chunk must appear in the exact projected and settled synthetic text;
 * the visible tail marker does not prove the full transcript fits onscreen.
 * Reveal ticks are observed separately from frames and channel notifications.
 * The producer stops and the reveal drains before settlement, so this is not
 * a test of settling while reveal still has a backlog. Each busy key waits
 * for a new stream event; asynchronous timer scheduling can bunch events and
 * the idle case does not have that pacing. Clicks reposition the caret inside
 * already visible input; they do not measure focusing an empty composer.
 *
 * Each key is unique and must change the cell immediately before the native
 * caret, close to the preceding caret; click must move it to the target. Checks
 * run only after xterm's async write callback, not on an arbitrary Ink frame.
 * A stream flush marker drains output already queued to the fake stdout between
 * samples, and stdin/output backpressure indicators are reported. This only
 * verifies the version xterm has presented by that callback: it cannot prove
 * no later output will supersede it, nor measure a real terminal's drain,
 * compositor, network, keyboard, or input-method latency. onFrame durations can
 * omit input/React work and phase timings can overlap. The optional profiler
 * adds overhead; sampling includes gated waiting and runtime work. To avoid
 * exposing user data it outputs only preapproved function names (same-name
 * functions are combined) and aggregate other/idle/GC buckets, not paths,
 * arbitrary function names, source, or raw profiles. Inclusive counts are
 * samples with that function anywhere on stack; self counts are leaf samples.
 * Repeat fresh processes; sample size, JIT, geometry and load matter.
 *
 * HOME, XDG and DSH state are isolated in an owned temporary directory; inherited
 * DSH_* options (including all log/trace paths) are removed before app imports.
 * The fake TTY has an owned fd for Ink's synchronous unmount writes, never fd 1.
 */
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { settled } from './lib/term-test.mjs'

// JSX runtime imports can load React before the module body. Require the
// production build in the process environment, as the real package entry does.
if (process.env.NODE_ENV !== 'production') throw new Error('Set NODE_ENV=production before starting this input benchmark')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-input-latency-'))
let ttyFd: number | undefined
try {
  for (const key of Object.keys(process.env)) if (key.startsWith('DSH_')) delete process.env[key]
  process.env.HOME = scratch
  process.env.USERPROFILE = scratch
  process.env.XDG_CONFIG_HOME = join(scratch, 'config')
  process.env.XDG_CACHE_HOME = join(scratch, 'cache')
  process.env.XDG_DATA_HOME = join(scratch, 'data')
  process.env.XDG_STATE_HOME = join(scratch, 'state')
  process.env.DSH_HOME = join(scratch, 'dsh')
  process.env.FORCE_COLOR = '3'
  process.env.DSH_TUI_LANG = 'zh'
  ttyFd = openSync(join(scratch, 'tty-output'), 'w')
  await main(ttyFd)
} finally {
  try { if (ttyFd !== undefined) closeSync(ttyFd) } finally { rmSync(scratch, { recursive: true, force: true }) }
}

async function main(fd: number): Promise<void> {
  const [React, { Terminal }, { Box, render, AlternateScreen }, { PromptInput }, { LOCAL_COMMANDS }] = await Promise.all([
    import('react'), import('@xterm/headless'), import('../src/ui.js'),
    import('../src/components/PromptInput.js'), import('../src/commands.js'),
  ])
  const COLS = 100, ROWS = 40
  const KEYS = Number(process.env.KEYS ?? 20)
  const draftUnit = process.env.DRAFT_UNIT ?? 'a'
  if (draftUnit === '' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(draftUnit)) throw new Error('DRAFT_UNIT must be nonempty and contain no newline or control characters')
  if (process.env.BENCH_CPU_PROFILE === '1' && process.env.BENCH_DSH_CHANNEL !== '1') throw new Error('BENCH_CPU_PROFILE=1 requires BENCH_DSH_CHANNEL=1')
  const busyInterval = Number(process.env.BUSY_INTERVAL_MS ?? 16)
  const sizes = (process.env.DRAFT_SIZES ?? '0,1000,5000').split(',').map(Number)
  const turnCounts = (process.env.CHAT_TURNS ?? '0,120,800').split(',').map(Number)
  const dshTurnCounts = (process.env.REAL_CHANNEL_TURNS ?? '0').split(',').map(Number)
  const realSmoothOption = process.env.REAL_SMOOTH_STREAMING ?? '1'
  if (realSmoothOption !== '0' && realSmoothOption !== '1') throw new Error('REAL_SMOOTH_STREAMING must be 0 or 1')
  const realSmoothStreaming = realSmoothOption === '1'
  if (process.env.BENCH_DSH_CHANNEL === '1' && (dshTurnCounts.length !== 1 || process.env.BENCH_CHAT === '1' || process.env.BENCH_CHAT_BUSY === '1')) {
    throw new Error('real channel requires one REAL_CHANNEL_TURNS value and a process without mock Chat fixtures')
  }
  if (!Number.isInteger(KEYS) || KEYS < 1 || KEYS > 50 || !Number.isInteger(busyInterval) || busyInterval < 1 || [...sizes, ...turnCounts, ...dshTurnCounts].some(n => !Number.isInteger(n) || n < 0)) {
    throw new Error('KEYS must be 1..50, BUSY_INTERVAL_MS positive; draft and turn counts must be nonnegative integers')
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmn'
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  const percentile = (values: number[], p: number) => {
    const sorted = [...values].sort((a, b) => a - b)
    return Number((sorted[Math.ceil(sorted.length * p) - 1] ?? 0).toFixed(2))
  }
  type Frame = { durationMs: number; phases?: { yoga: number; renderer: number; diff: number; write: number; commit: number } }
  type Pending = { check: () => boolean; start: number; resolve: (duration: number) => void }

  function makeHarness() {
    const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
    let pending: Pending | undefined
    let outputBytes = 0, outputWrites = 0, outputDrainEvents = 0, maxOutputQueuedBytes = 0, stdinBackpressure = 0
    const lines = () => Array.from({ length: ROWS }, (_, row) => term.buffer.active.getLine(term.buffer.active.baseY + row)?.translateToString(true) ?? '')
    class Out extends Writable {
      columns = COLS
      rows = ROWS
      isTTY = true
      fd = fd
      override _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) {
        const text = String(chunk)
        outputWrites++
        outputBytes += Buffer.byteLength(text)
        maxOutputQueuedBytes = Math.max(maxOutputQueuedBytes, this.writableLength)
        term.write(text, () => {
          if (pending?.check()) {
            const sample = pending
            pending = undefined
            sample.resolve(performance.now() - sample.start)
          }
          done()
        })
      }
    }
    class In extends PassThrough {
      isTTY = true
      setRawMode() { return this }
      override ref() { return this }
      override unref() { return this }
    }
    const stdout = new Out(), stdin = new In()
    stdout.on('drain', () => { outputDrainEvents++ })
    const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
    const flush = () => new Promise<void>((resolve, reject) => stdout.write('', error => error ? reject(error) : resolve()))
    const send = (input: string) => { if (!stdin.write(input)) stdinBackpressure++ }
    const stats = () => ({ outputWrites, outputBytes, outputDrainEvents, maxOutputQueuedBytes, stdinBackpressure })
    const measure = async (check: () => boolean, trigger: () => void, label: string) => {
      if (pending) throw new Error('overlapping measurement')
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = new Promise<number>((resolve, reject) => {
        pending = { check, start: performance.now(), resolve }
        timer = setTimeout(() => { pending = undefined; reject(new Error(`timeout ${label}`)) }, 15_000)
      })
      try { trigger(); return await result } finally { clearTimeout(timer); pending = undefined }
    }
    const caret = () => ({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY })
    const at = (x: number, y: number) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.getCell(x)?.getChars() ?? ''
    const type = async (label: string, hooks?: { beforeKey?: () => Promise<void>; started?: () => void; finished?: () => void; draftMatches?: (expected: string) => boolean }) => {
      const samples: number[] = []
      for (let index = 0; index < KEYS; index++) {
        await flush()
        await hooks?.beforeKey?.()
        const before = caret()
        // Snapshot terminal cells, not JS string offsets: a CJK/emoji prefix
        // can make UTF-16 indices disagree with physical terminal columns.
        const previous = new Map<number, string[]>()
        for (let row = Math.max(0, before.y - 3); row <= Math.min(ROWS - 1, before.y + 2); row++) {
          previous.set(row, Array.from({ length: COLS }, (_, col) => at(col, row)))
        }
        const character = alphabet[index]!
        samples.push(await measure(() => {
          const after = caret()
          if (after.x === before.x && after.y === before.y) return false
          if (Math.abs(after.y - before.y) > 2) return false
          // ASCII input places its newly drawn cell immediately before caret.
          // For a wrap at column 0 the previous row's last cell is the target.
          const x = after.x === 0 ? COLS - 1 : after.x - 1
          const y = after.x === 0 ? after.y - 1 : after.y
          if (y < 0 || y >= ROWS) return false
          return at(x, y) === character && previous.get(y)?.[x] !== character && (hooks?.draftMatches?.(alphabet.slice(0, index + 1)) ?? true)
        }, () => { hooks?.started?.(); send(character) }, `${label} key=${index + 1}`))
        hooks?.finished?.()
      }
      await flush()
      return samples
    }
    return { term, stdout, stdin, stderr, lines, flush, send, stats, measure, caret, at, type }
  }
  function report(label: Record<string, unknown>, times: number[], frames: Frame[], stats: ReturnType<ReturnType<typeof makeHarness>['stats']>) {
    const sum = (phase: 'yoga' | 'renderer' | 'diff' | 'write' | 'commit') => Number(frames.reduce((total, frame) => total + (frame.phases?.[phase] ?? 0), 0).toFixed(2))
    console.log(JSON.stringify({ ...label, keys: times.length, latencyMs: { p50: percentile(times, 0.5), p95: percentile(times, 0.95), max: percentile(times, 1) }, frames: frames.length, frameP95Ms: percentile(frames.map(frame => frame.durationMs), 0.95), phaseTotalsMs: { yoga: sum('yoga'), renderer: sum('renderer'), diff: sum('diff'), write: sum('write'), commit: sum('commit') }, stream: stats }))
  }

  for (const draftChars of sizes) {
    const h = makeHarness()
    const controller: { current: { append(text: string): string; text(): string } | null } = { current: null }
    const channel = { whaleIdle: false, mode: { id: 'default', plan: false }, modeIndex: 0, cycleMode() {}, commandList: LOCAL_COMMANDS, commandCompletions: () => [], notifications: [], pending: [], working: false, notify() {}, submit() {}, steer() {}, interruptAndDeliver() { return 0 }, removePending() { return false }, stageImage() {}, listFiles: async () => [], sessionColor: '' }
    let measuring = false, totalFrames = 0
    const frames: Frame[] = []
    const app = await render(<AlternateScreen><Box height={ROWS} flexDirection="column" justifyContent="flex-end"><PromptInput channel={channel as never} helpOpen={false} onToggleHelp={() => {}} onRunCommand={() => false} selectionActive={false} controllerRef={controller as never} /></Box></AlternateScreen>, { stdout: h.stdout as never, stdin: h.stdin as never, stderr: h.stderr as never, exitOnCtrlC: false, patchConsole: false, onFrame: frame => { totalFrames++; if (measuring) frames.push(frame as Frame) } })
    try {
      if (!await settled(() => controller.current !== null && h.stats().outputWrites > 0, { timeoutMs: 8000 })) throw new Error('prompt controller unavailable')
      const seed = draftUnit.repeat(draftChars)
      const framesBeforeSeed = totalFrames
      controller.current!.append(seed)
      if (!await settled(() => controller.current?.text() === seed && (draftChars === 0 || totalFrames > framesBeforeSeed), { timeoutMs: 8000 })) throw new Error('seeded draft did not reach a rendered frame')
      await sleep(500) // 固定窗:pacing 统一组件预热窗，减少不同草稿首帧和 JIT 干扰
      await h.flush()
      measuring = true
      const times = await h.type(`draft=${draftChars}`)
      measuring = false
      const draftInfo = { draftUnit, unitUtf16Length: draftUnit.length, draftRepeatCount: draftChars, draftUtf16Length: seed.length }
      report({ fixture: 'prompt', ...draftInfo }, times, frames, h.stats())
      // Verify the ENTIRE synthetic typed suffix backwards from the native
      // caret, across actual display rows. A cursor column includes the input
      // gutter: x >= 9 does not imply nine text cells exist on the final row.
      let typed = alphabet.slice(0, KEYS)
      const diagnoseGeometry = (reason: string): void => {
        const cursor = h.caret()
        const text = controller.current?.text() ?? ''
        const screen = h.lines()
        const nearby = Array.from({ length: 6 }, (_, index) => cursor.y - 4 + index)
          .filter(index => index >= 0 && index < ROWS)
          .map(index => ({ row: index, text: screen[index], cells: Array.from({ length: COLS }, (_, x) => h.at(x, index)) }))
        // The channel, seed, and keys are synthetic; never read a real session.
        console.error(`CLICK_SUFFIX_DIAGNOSTIC ${JSON.stringify({ reason, cursor, typed, draftUtf16Length: text.length, draftTail: text.slice(-80), expectedDraftUtf16Length: seed.length + typed.length, expectedDraft: text === seed + typed, totalFrames, stream: h.stats(), nearby })}`)
      }
      const failGeometry = (reason: string): never => { diagnoseGeometry(reason); throw new Error('cursor-anchored click suffix mismatch') }
      const typedRuns = () => {
        if (controller.current?.text() !== seed + typed) return failGeometry('composer draft does not contain the exact injected suffix')
        const cursor = h.caret()
        let pending = typed.length - 1, row = cursor.y, col = cursor.x - 1
        const runs: Array<{ row: number; start: number; end: number }> = []
        while (pending >= 0 && row >= 0) {
          // A previous wrapped row can have unused right margin. Do not skip
          // any nonblank cell, or we could conceal a real corrupted redraw.
          if (row !== cursor.y) while (col >= 0 && (h.at(col, row) === '' || h.at(col, row) === ' ')) col--
          const end = col
          while (pending >= 0 && col >= 0 && h.at(col, row) === typed[pending]) { pending--; col-- }
          if (col === end) return failGeometry('expected typed cell missing at caret or wrapped-row boundary')
          const start = col + 1
          runs.push({ row, start, end })
          if (pending < 0) break
          const firstContent = Array.from({ length: COLS }, (_, x) => h.at(x, row)).findIndex(cell => cell !== '' && cell !== ' ')
          if (firstContent !== start) return failGeometry('typed suffix has an internal gap, not a row wrap')
          row--
          col = COLS - 1
        }
        if (pending >= 0) return failGeometry('typed suffix not fully visible')
        return runs
      }
      let runs = typedRuns()
      let clickPaddingKeys = 0
      // Click the CURRENT caret row: selecting an earlier wrapped row can move
      // the viewport, invalidating physical coordinates. If fewer than four
      // characters fit there, extend the synthetic draft outside the typing
      // timing window; record the exact number and verify each extra key.
      while (runs[0]!.end - runs[0]!.start < 3 && clickPaddingKeys < 7) {
        await h.flush()
        const before = h.caret()
        const next = typed + '~'
        await h.measure(() => {
          const after = h.caret()
          const x = after.x === 0 ? COLS - 1 : after.x - 1
          const y = after.x === 0 ? after.y - 1 : after.y
          return (after.x !== before.x || after.y !== before.y) && y >= 0 && h.at(x, y) === '~' && controller.current?.text() === seed + next
        }, () => h.send('~'), `click precondition draft=${draftChars} key=${clickPaddingKeys + 1}`)
        typed = next
        clickPaddingKeys++
        await h.flush()
        runs = typedRuns()
      }
      const run = runs[0]!
      if (run.end - run.start < 3) failGeometry('cannot establish two separated interior click targets')
      const clicks: number[] = []
      for (let index = 0; index < 10; index++) {
        await h.flush()
        // At a wrap join, the boundary at start maps to the preceding row.
        // Stay inside the run, and separate clicks by >=2 cells to avoid the
        // composer's double-click word-selection rule.
        const target = index % 2 === 0 ? run.start + 1 : run.end
        const before = h.caret()
        if (before.x === target && before.y === run.row) throw new Error('click must move cursor')
        try {
          clicks.push(await h.measure(() => { const after = h.caret(); return after.x === target && after.y === run.row }, () => {
            h.send(`\x1b[<0;${target + 1};${run.row + 1}M`)
            h.send(`\x1b[<0;${target + 1};${run.row + 1}m`)
          }, `click draft=${draftChars} target=${target},${run.row}`))
        } catch (error) {
          diagnoseGeometry(`click did not land at ${target},${run.row}`)
          throw error
        }
      }
      await h.flush()
      console.log(JSON.stringify({ fixture: 'prompt-click', ...draftInfo, clickPaddingKeys, typedSuffixRuns: runs.length, clicks: clicks.length, clickToCursorMs: { p50: percentile(clicks, 0.5), p95: percentile(clicks, 0.95), max: percentile(clicks, 1) }, stream: h.stats() }))
    } finally {
      await app.unmount()
      await h.flush()
      h.term.dispose()
    }
  }

  const runBusy = process.env.BENCH_CHAT_BUSY === '1'
  if (process.env.BENCH_CHAT === '1' || runBusy) {
    const [{ Chat }, { QuestionStore }, { completeCommands }] = await Promise.all([import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'), import('../src/commands.js')])
    for (const turns of turnCounts) for (const busy of runBusy ? [false, true] : [false]) {
      const h = makeHarness()
      const rows: unknown[] = []
      let id = 0
      for (let turn = 1; turn <= turns; turn++) {
        rows.push({ id: ++id, kind: 'user', text: `问题 ${turn}` })
        for (let tool = 0; tool < 2; tool++) rows.push({ id: ++id, kind: 'tool', text: '', tool: { callId: `${turn}-${tool}`, name: 'Read', argsText: '{"file_path":"/tmp/f.ts"}', argsFull: '{}', status: 'ok', startedAt: 0, durationMs: 30, resultText: '内容行 1\n内容行 2' } })
        rows.push({ id: ++id, kind: 'assistant', text: `回复 ${turn} 第一行\n回复第二行` })
      }
      // The extra assistant row is present in both fixtures. Only the busy
      // variant mutates its text and emits channel versions during typing.
      const streamRow = { id: ++id, kind: 'assistant', text: 'synthetic stream: ', streaming: busy }
      if (runBusy) rows.push(streamRow)
      const listeners = new Set<() => void>()
      const channel = { whaleIdle: false, whale: false, version: 0, rows, status: busy ? 'running' : 'idle', sessionTitle: 'probe', agentId: 'probe', model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', effortLevels: [], tokens: { input: 0, output: 0 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo', gitBranch: 'main', working: busy, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0, turnStart: 0, pending: [], commandList: LOCAL_COMMANDS, notifications: [], mode: { plan: false }, activityFrames: 'moon8', subagents: [], lastUserText: '', scrollGutter: 'timeline', subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) }, submit() {}, cancel() {}, clear() {}, notify() {}, listModels: async () => [], listSessions: async () => [], deleteSession: async () => true, renameSessionTo: async () => true, setResumeTarget() {}, loadOlder() {}, mcpStatus: () => [], pushLocal() {}, commandCompletions: (input: string) => completeCommands(input) }
      let measuring = false
      const frames: Frame[] = []
      let interval: ReturnType<typeof setInterval> | undefined
      let updates = 0, notifications = 0, updatesInFlight = 0, keysWithOverlap = 0, gatedKeys = 0
      let inFlight = false, keyStartVersion = 0
      let nextEvent: (() => void) | undefined
      const app = await render(<AlternateScreen><Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen trajectorySeen /></AlternateScreen>, { stdout: h.stdout as never, stdin: h.stdin as never, stderr: h.stderr as never, exitOnCtrlC: false, patchConsole: false, onFrame: frame => { if (measuring) frames.push(frame as Frame) } })
      try {
        if (!await settled(() => listeners.size > 0 && h.stats().outputWrites > 0, { timeoutMs: 8000 })) throw new Error('chat not subscribed or painted')
        await sleep(1500) // 固定窗:pacing 统一 Chat 基准预热窗，减少开场动画和 JIT 对组间的干扰
        await h.flush()
        if (busy) {
          interval = setInterval(() => {
            updates++
            streamRow.text += ` chunk-${String(updates).padStart(5, '0')}`
            channel.responseChars = streamRow.text.length
            channel.version++
            if (inFlight) updatesInFlight++
            notifications += listeners.size
            for (const listener of listeners) listener()
            const resolve = nextEvent
            nextEvent = undefined
            resolve?.()
          }, busyInterval)
        }
        measuring = true
        const times = await h.type(`chat turns=${turns} busy=${busy}`, busy ? {
          beforeKey: () => new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => { nextEvent = undefined; reject(new Error('stream event timeout')) }, 15_000)
            nextEvent = () => { clearTimeout(timeout); gatedKeys++; resolve() }
          }),
          started: () => { keyStartVersion = updates; inFlight = true },
          finished: () => { inFlight = false; if (updates > keyStartVersion) keysWithOverlap++ },
        } : undefined)
        measuring = false
        if (interval !== undefined) { clearInterval(interval); interval = undefined }
        let visibleConfirmed = false
        if (busy) {
          if (updates < KEYS || gatedKeys !== KEYS || notifications < updates) throw new Error(`stream not delivered: updates=${updates} gated=${gatedKeys} notifications=${notifications}`)
          // The final synthetic marker must reach xterm, not merely mutate the
          // mock. Timers have stopped; allow the scheduled React render to land.
          const marker = `chunk-${String(updates).padStart(5, '0')}`
          visibleConfirmed = await settled(() => h.lines().some(line => line.includes(marker)), { stepMs: 20, timeoutMs: 5000 })
          if (!visibleConfirmed) throw new Error(`stream final marker not painted: ${marker}`)
          await h.flush()
        }
        report({ fixture: 'chat-mock', phase: busy ? 'simulated-stream' : 'idle', turns, rows: rows.length, ...(busy ? { simulatedStream: { intervalMs: busyInterval, updates, notifications, gatedKeys, updatesInFlight, keysWithOverlap, visibleConfirmed } } : {}) }, times, frames, h.stats())
      } finally {
        if (interval !== undefined) clearInterval(interval)
        await app.unmount()
        await h.flush()
        h.term.dispose()
      }
    }
  }

  if (process.env.BENCH_DSH_CHANNEL === '1') {
    const [{ Chat }, { QuestionStore }, { createChannel }, { mountChannelUi }, { registerTuiChannel }, { bindChannelCommands }, { subscribeReveal, isRevealTimerRunning, resetRevealForTest }] = await Promise.all([
      import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'), import('../src/dsh-adapter/channel.js'),
      import('../src/dsh-adapter/channel-ui.js'), import('../src/adapter/channel/host-registry.js'), import('../src/dsh-adapter/channel/commands.js'),
      import('../src/components/smoothReveal.js'),
    ])
    // Import/connect only when explicitly enabled; Session.connect() is local
    // to this process and does not open an inspector listening socket.
    const profileInput = process.env.BENCH_CPU_PROFILE === '1' ? await (async () => {
      const inspector = await import('node:inspector')
      const allowedFunctions = new Set([
        'PromptInput', 'Chat', 'caretInText', 'wrapLineRows', 'wrapToWidth', 'visualLineRanges', 'clickToCursorOffset',
        'diffSpan', 'recordDraftEdit', 'setInput', 'stringWidth', 'stringWidthJavaScript', 'layoutNode',
        'renderNodeToOutput', 'render', 'onRender', 'calculateLayout', 'workLoopSync', 'performUnitOfWork',
        'beginWork', 'completeWork', 'commitRoot', 'flushSyncWorkAcrossRoots_impl',
        '(idle)', '(program)', '(garbage collector)',
      ])
      type CpuProfile = { nodes: Array<{ id: number; children?: number[]; callFrame: { functionName: string } }>; samples?: number[]; timeDeltas?: number[]; startTime: number; endTime: number }
      function summarizeProfile(profile: CpuProfile) {
        const samples = profile.samples ?? []
        if (samples.length === 0) throw new Error('CPU profiler returned no samples')
        const nodes = new Map(profile.nodes.map(node => [node.id, node]))
        const parents = new Map<number, number>()
        for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
        const counts = new Map<string, { self: number; inclusive: number }>()
        const bucket = (name: string) => {
          const current = counts.get(name) ?? { self: 0, inclusive: 0 }
          counts.set(name, current)
          return current
        }
        for (const id of samples) {
          const node = nodes.get(id)
          if (!node) throw new Error('CPU profiler returned an unknown sample node')
          const name = node.callFrame.functionName
          bucket(allowedFunctions.has(name) ? name : '(other)').self++
          const seen = new Set<string>()
          let cursor: number | undefined = id
          while (cursor !== undefined) {
            const current = nodes.get(cursor)
            if (!current) throw new Error('CPU profiler returned an unknown stack node')
            const key = current.callFrame.functionName
            if (allowedFunctions.has(key) && !seen.has(key)) { bucket(key).inclusive++; seen.add(key) }
            cursor = parents.get(cursor)
          }
        }
        return {
          sampleCount: samples.length,
          durationMs: Number(((profile.endTime - profile.startTime) / 1000).toFixed(2)),
          attribution: 'self samples and inclusive stack samples; names merged; other is self only',
          functions: [...counts].map(([functionName, count]) => ({ functionName, selfSamples: count.self, inclusiveSamples: count.inclusive })).sort((a, b) => b.inclusiveSamples - a.inclusiveSamples || b.selfSamples - a.selfSamples),
        }
      }
      return async function profileInput(work: () => Promise<number[]>) {
        const session = new inspector.Session()
        const failures: unknown[] = []
        let connected = false, enabled = false, running = false
        let times: number[] | undefined
        let profile: CpuProfile | undefined
        const enable = () => new Promise<void>((resolve, reject) => session.post('Profiler.enable', error => error ? reject(error) : resolve()))
        const start = () => new Promise<void>((resolve, reject) => session.post('Profiler.start', error => error ? reject(error) : resolve()))
        const stop = () => new Promise<CpuProfile>((resolve, reject) => session.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(result.profile as CpuProfile)))
        const disable = () => new Promise<void>((resolve, reject) => session.post('Profiler.disable', error => error ? reject(error) : resolve()))
        try {
          session.connect(); connected = true
          await enable(); enabled = true
          await start(); running = true
          times = await work()
        } catch (error) { failures.push(error) }
        finally {
          if (running) try { profile = await stop() } catch (error) { failures.push(error) }
          if (enabled) try { await disable() } catch (error) { failures.push(error) }
          if (connected) try { session.disconnect() } catch (error) { failures.push(error) }
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'CPU profiling or input measurement failed')
        if (times === undefined || profile === undefined) throw new Error('CPU profiling did not produce a result')
        return { times, cpuProfile: summarizeProfile(profile) }
      }
    })() : undefined
    for (const turns of dshTurnCounts) for (const busy of [false, true]) {
      type RawEvent = { type: string; seq: number; time: number; data: Record<string, unknown> }
      const events: RawEvent[] = []
      let seq = 0
      const event = (type: string, data: Record<string, unknown>): RawEvent => ({ type, seq: ++seq, time: seq, data })
      for (let turn = 1; turn <= turns; turn++) {
        events.push(event('user/message', { id: `synthetic-user-${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text: `synthetic question ${turn}` }] }))
        events.push(event('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `synthetic answer ${turn}` }] } }))
      }
      const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>()
      const cleanups: (() => void)[] = []
      const agent = { id: 'synthetic-dsh-agent', status: 'idle', session: { id: 'synthetic-dsh-session', seq, events, header: { cwd: scratch } }, ctx: { on: () => () => undefined }, followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true } }
      const services: Record<string, unknown> = {
        settings: { describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: {}, value: {} }, { ns: 'dsh-tui', revision: 1, user: {}, value: { recapOnOpen: false } }], get: () => ({}), mutate: async () => undefined },
        credentials: { resolve: async () => undefined, set: async () => undefined, unset: async () => undefined },
        llm: { listConfigurableProviders: () => [], discoverModels: async () => [] },
        agents: { create: async () => { throw new Error('synthetic fixture refuses create') }, resume: async () => { throw new Error('synthetic fixture refuses resume') } },
      }
      const ctx = {
        on(name: string, callback: (...args: unknown[]) => unknown) {
          const bucket = listeners.get(name) ?? new Set()
          bucket.add(callback)
          listeners.set(name, bucket)
          return () => { bucket.delete(callback) }
        },
        effect(setup: () => () => void) { cleanups.push(setup()) },
        get(name: string) { return services[name] },
        logger: { warn() {} },
      }
      const raw = createChannel(ctx as never, agent as never, { model: 'synthetic', provider: 'synthetic', cwd: scratch, activity: false, whale: false, whaleIdle: false, minimalUi: true, smoothStreaming: realSmoothStreaming })
      // Count real router calls into the production frame-coalescing emitter;
      // the wrapper delegates to the original implementation unmodified.
      let measuring = false, emitStreamCalls = 0, emitStreamCallsDuringTyping = 0
      const originalEmitStream = raw.emitStream
      raw.emitStream = () => {
        emitStreamCalls++
        if (measuring) emitStreamCallsDuringTyping++
        originalEmitStream()
      }
      const unregister = registerTuiChannel(ctx, raw)
      const mount = mountChannelUi(ctx, raw, undefined, 'new')
      bindChannelCommands(raw, mount.channel)
      if (mount.channel.smoothStreaming !== realSmoothStreaming) throw new Error('real channel smoothStreaming configuration mismatch')
      let revealTicks = 0, revealTicksDuringTyping = 0
      const unsubscribeReveal = subscribeReveal(() => { revealTicks++; if (measuring) revealTicksDuringTyping++ })
      let notifications = 0, notificationsDuringTyping = 0
      const unsubscribe = mount.channel.subscribe(() => { notifications++; if (measuring) notificationsDuringTyping++ })
      const h = makeHarness()
      const controller: { current: { text(): string } | null } = { current: null }
      const frames: Frame[] = []
      let totalFrames = 0
      let interval: ReturnType<typeof setInterval> | undefined
      let ingressChunks = 0, sessionIngress = 0, startFrames = 0, endFrames = 0, sessionHandlerCalls = 0, streamHandlerCalls = 0, updatesInFlight = 0, keysWithOverlap = 0, gatedKeys = 0
      let inFlight = false, keyStartCount = 0, revision = 0
      let nextEvent: (() => void) | undefined
      let expected = ''
      const deliver = (name: string, ...args: unknown[]) => {
        const handlers = [...(listeners.get(name) ?? [])]
        if (handlers.length === 0) throw new Error(`no real channel handler for ${name}`)
        for (const handler of handlers) {
          if (name === 'session/event') sessionHandlerCalls++
          if (name === 'agent/assistant-stream') streamHandlerCalls++
          handler(...args)
        }
      }
      const appendEvent = (type: string, data: Record<string, unknown>) => {
        const item = event(type, data)
        agent.session.seq = item.seq
        agent.session.events.push(item)
        sessionIngress++
        deliver('session/event', agent.session, item)
        return item
      }
      const sendFrame = (frame: Record<string, unknown>) => {
        if (frame.type === 'start') startFrames++
        if (frame.type === 'end') endFrames++
        deliver('agent/assistant-stream', { agent, frame })
      }
      const app = await render(<AlternateScreen><Chat channel={mount.channel} questionStore={new QuestionStore()} fullscreen trajectorySeen promptControllerRef={controller as never} /></AlternateScreen>, {
        stdout: h.stdout as never, stdin: h.stdin as never, stderr: h.stderr as never, exitOnCtrlC: false, patchConsole: false,
        onFrame: frame => { totalFrames++; if (measuring) frames.push(frame as Frame) },
      })
      try {
        if (!await settled(() => (listeners.get('agent/assistant-stream')?.size ?? 0) > 0 && h.stats().outputWrites > 0 && controller.current !== null, { timeoutMs: 8000 })) throw new Error('real channel not subscribed, painted or ready for input')
        await sleep(1500) // 固定窗:pacing 统一真实通道预热窗，降低历史折叠和启动帧对组间的干扰
        await h.flush()
        notifications = 0
        notificationsDuringTyping = 0
        revealTicks = 0
        revealTicksDuringTyping = 0
        emitStreamCalls = 0
        emitStreamCallsDuringTyping = 0
        sessionHandlerCalls = 0
        streamHandlerCalls = 0
        if (busy) {
          appendEvent('turn/start', { turn: turns + 1 })
          appendEvent('step/start', { turn: turns + 1, step: 1 })
          sendFrame({ type: 'start', revision: ++revision, attemptId: 'synthetic-attempt', turn: turns + 1, step: 1 })
        }
        const runInputWindow = async () => {
          if (busy) {
            interval = setInterval(() => {
              const index = ingressChunks++
              const text = `${index === 0 ? '' : ' '}B${String(index).padStart(5, '0')}`
              expected += text
              if (inFlight) updatesInFlight++
              sendFrame({ type: 'chunk', revision: ++revision, attemptId: 'synthetic-attempt', index, time: Date.now(), chunk: { type: 'text-delta', index: 0, text } })
              const resolve = nextEvent
              nextEvent = undefined
              resolve?.()
            }, busyInterval)
          }
          measuring = true
          try {
            return await h.type(`real-dsh turns=${turns} busy=${busy}`, {
              draftMatches: text => controller.current?.text() === text,
              ...(busy ? {
                beforeKey: () => new Promise<void>((resolve, reject) => {
                  const timeout = setTimeout(() => { nextEvent = undefined; reject(new Error('real channel stream event timeout')) }, 15_000)
                  nextEvent = () => { clearTimeout(timeout); gatedKeys++; resolve() }
                }),
                started: () => { keyStartCount = ingressChunks; inFlight = true },
                finished: () => { inFlight = false; if (ingressChunks > keyStartCount) keysWithOverlap++ },
              } : {}),
            })
          } finally {
            measuring = false
            if (interval !== undefined) { clearInterval(interval); interval = undefined }
          }
        }
        const { times, cpuProfile } = profileInput === undefined
          ? { times: await runInputWindow(), cpuProfile: undefined }
          : await profileInput(runInputWindow)
        let fullProjectedText = false, finalPaint = false, fullSettledText = false, settledFrame = false, settledTailVisible = false, revealTimerDrained = false
        if (busy) {
          if (ingressChunks < KEYS || gatedKeys !== KEYS || emitStreamCalls < ingressChunks || notifications === 0) throw new Error(`real channel stream inactive: chunks=${ingressChunks}, gated=${gatedKeys}, emitStream=${emitStreamCalls}, notifications=${notifications}`)
          if (realSmoothStreaming && revealTicksDuringTyping === 0) throw new Error('smooth reveal did not advance during input')
          fullProjectedText = await settled(() => mount.channel.rows.some(row => row.kind === 'assistant' && row.streaming === true && row.text === expected), { timeoutMs: 8000 })
          if (!fullProjectedText) throw new Error(`real channel lost stream text: expected ${expected.length} chars`)
          const marker = `B${String(ingressChunks - 1).padStart(5, '0')}`
          finalPaint = await settled(() => h.lines().some(line => line.includes(marker)), { timeoutMs: 30_000 })
          if (!finalPaint) throw new Error(`real channel stream tail not painted: ${marker}`)
          revealTimerDrained = await settled(() => !isRevealTimerRunning(), { timeoutMs: 30_000 })
          if (!revealTimerDrained) throw new Error('smooth reveal timer did not drain')
          const framesBeforeSettlement = totalFrames
          const item = appendEvent('assistant/message', { turn: turns + 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: expected }] } })
          sendFrame({ type: 'end', revision: ++revision, attemptId: 'synthetic-attempt', index: ingressChunks, outcome: { kind: 'committed', eventType: 'assistant/message', seq: item.seq } })
          fullSettledText = await settled(() => mount.channel.rows.some(row => row.kind === 'assistant' && row.streaming !== true && row.text === expected), { timeoutMs: 8000 })
          if (!fullSettledText) throw new Error('real channel settlement lost full stream text')
          settledFrame = await settled(() => totalFrames > framesBeforeSettlement, { timeoutMs: 8000 })
          if (!settledFrame) throw new Error('no frame after real channel settlement')
          await h.flush()
          settledTailVisible = await settled(() => h.lines().some(line => line.includes(marker)), { timeoutMs: 8000 })
          if (!settledTailVisible) throw new Error('settled stream tail not visible')
        }
        await h.flush()
        if (!realSmoothStreaming && revealTicks !== 0) throw new Error('reveal advanced while smooth streaming disabled')
        report({ fixture: 'real-dsh-channel-synthetic-host', phase: busy ? 'simulated-stream' : 'idle', turns, smoothStreaming: mount.channel.smoothStreaming, rows: mount.channel.rows.length, revealTicks: { duringTyping: revealTicksDuringTyping, total: revealTicks }, ...(cpuProfile === undefined ? {} : { cpuProfile }), ...(busy ? { realChannelStream: { intervalMs: busyInterval, ingress: { sessionEvents: sessionIngress, startFrames, chunks: ingressChunks, endFrames }, handlerCalls: { session: sessionHandlerCalls, stream: streamHandlerCalls }, emitStreamCalls: { duringTyping: emitStreamCallsDuringTyping, total: emitStreamCalls }, uiNotifications: { duringTyping: notificationsDuringTyping, total: notifications }, gatedKeys, updatesInFlight, keysWithOverlap, fullProjectedText, finalPaint, revealTimerDrained, fullSettledText, settledFrame, settledTailVisible } } : { uiNotifications: notifications }) }, times, frames, h.stats())
      } finally {
        if (interval !== undefined) clearInterval(interval)
        await app.unmount()
        await h.flush()
        h.term.dispose()
        unsubscribe()
        unsubscribeReveal()
        mount.dispose()
        unregister()
        for (const cleanup of [...cleanups].reverse()) cleanup()
        // The preceding Chat and its observers are fully unmounted; drain and
        // clear module-global reveal keys before the next (idle/busy) fixture.
        if (!await settled(() => !isRevealTimerRunning(), { timeoutMs: 30_000 })) throw new Error('reveal timer remained active after unmount')
        resetRevealForTest()
      }
    }
  }
}
