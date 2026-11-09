/**
 * External-clock input probe (not part of the default install or test suite).
 * Run serially: node --import tsx/esm scripts/perf-input-external.tsx
 * MODE=idle|stream (default idle); SMOOTH=1|0 (default 1, production setting);
 * TAIL_KIND=plain|rich|fence; TAIL_SIZE=0..1000000 ASCII payload characters
 * (fence adds its opening delimiter outside that size);
 * TURNS=0..1000, KEYS=1..50, KEY_INTERVAL_MS=1..5000,
 * STREAM_INTERVAL_MS=1..5000, TIMEOUT_MS=100..60000; PROFILE=0|1, TRACE=0|1,
 * PRELOAD_HIGHLIGHT=0|1 (all default 0). Preload is a benchmark-only control,
 * shifts loader cost before the window, and is not a product fix.
 * PROFILE=1 uses a local inspector CPU sampler; it perturbs the timings and is
 * for attribution only, never an A/B latency threshold. Its window starts before
 * stream setup/seed and ends after freeze stops production; CPU/ELU separately
 * cover child ready→freeze and include the parent's pre-key wait.
 * TRACE=1 adds bounded timestamp/IPC overhead and is diagnostic, not a gate.
 * Same-host hrtime relates writes and callbacks; a readable event after a send
 * is only a temporal candidate, not proof that a particular byte was read.
 * Each invocation is one isolated case. Compare fresh processes serially.
 * The child uses NODE_ENV=production before loading React, matching the default
 * package entry's force-production-react behavior rather than the dev build.
 *
 * Parent writes keys on its own event loop, at absolute scheduled offsets. Its
 * send timestamp immediately precedes stdin.write, not the intended deadline;
 * scheduling lateness and pipe backpressure are reported separately. An xterm
 * child Out._write calls are length-framed on an isolated pipe. The parent
 * checks xterm after EACH original write callback, even if the pipe merged writes.
 * Cumulative prefixes in one original write acknowledge their keys together.
 * Framing copies each write and adds a 4-byte header plus parent parsing cost;
 * pipe and xterm backpressure can perturb the child; this is not zero overhead.
 * Percentiles cover ONLY on-time observations and always state the denominator;
 * late, timeout, unsent, process failures and every planned sample are reported.
 * This is a pipe plus headless emulator, not a physical terminal or real IME.
 * A separate event loop includes child blocking that began before a key was sent,
 * but not parent scheduling delay before the actual send, OS keyboard handling,
 * screen presentation, or real backend/network workload. Never attaches to a
 * user process or session. Child services, history and stream are synthetic.
 */
import { spawn } from 'node:child_process'
import { closeSync, createWriteStream, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { EventEmitter } from 'node:events'

// Bounded per original output write; oversize is a hard failure, never truncated.
const COLS = 120, ROWS = 40, MAX_FRAME_BYTES = 16 * 1024 * 1024
// Each side retains at most 1000 records; every additional event is counted.
const TRACE_SIDE_LIMIT = 1000
type TraceEntry = { kind: 'readable'; timeNs: string; unreadBytes: number } | { kind: 'write'; timeNs: string; writeIndex: number }
type ChildTrace = { entries: TraceEntry[]; droppedReadable: number; droppedWrites: number }
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmn'
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
// Event notifications plus one deadline; no periodic child-process polling.
function waitFor(signal: EventEmitter, predicate: () => boolean, timeoutMs: number, stop: () => boolean = () => false): Promise<boolean> {
  return new Promise(resolve => {
    const finish = (value: boolean) => { clearTimeout(timer); signal.off('change', check); resolve(value) }
    const check = () => { if (predicate()) finish(true); else if (stop()) finish(false) }
    const timer = setTimeout(() => finish(predicate()), timeoutMs)
    signal.on('change', check)
    check()
  })
}
const configNumber = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`)
  return value
}
const choose = (name: string, fallback: string, options: string[]) => {
  const value = process.env[name] ?? fallback
  if (!options.includes(value)) throw new Error(`${name} must be one of ${options.join(', ')}`)
  return value
}
const config = {
  mode: choose('MODE', 'idle', ['idle', 'stream']),
  smooth: choose('SMOOTH', '1', ['0', '1']) === '1',
  profile: choose('PROFILE', '0', ['0', '1']) === '1',
  trace: choose('TRACE', '0', ['0', '1']) === '1',
  preloadHighlight: choose('PRELOAD_HIGHLIGHT', '0', ['0', '1']) === '1',
  tailKind: choose('TAIL_KIND', 'plain', ['plain', 'rich', 'fence']),
  tailSize: configNumber('TAIL_SIZE', 0, 0, 1_000_000),
  turns: configNumber('TURNS', 0, 0, 1000),
  keys: configNumber('KEYS', 20, 1, 50),
  keyIntervalMs: configNumber('KEY_INTERVAL_MS', 50, 1, 5000),
  streamIntervalMs: configNumber('STREAM_INTERVAL_MS', 16, 1, 5000),
  timeoutMs: configNumber('TIMEOUT_MS', 10000, 100, 60000),
}

if (process.argv.includes('--child')) await childMain()
else await parentMain()

// Only created in the isolated child when explicitly requested; Session.connect
// is in-process and opens no inspector listening socket. Never emit raw paths,
// URLs, arbitrary function names, or the raw profile.
async function createCpuProfiler() {
  const inspector = await import('node:inspector')
  const session = new inspector.Session()
  const allowed = new Set([
    'PromptInput', 'Chat', 'MessageList', 'StreamingMarkdown', 'MarkdownImpl', 'CodeBlockFrame',
    'analyzeStableBoundary', 'analyzeSuffixStart', 'lexWithCache', 'renderTokensToNodes',
    'lex', 'lexer', 'blockTokens', 'inlineTokens', 'tokenize', 'parse', 'highlight',
    'caretInText', 'wrapLineRows', 'wrapToWidth', 'visualLineRanges', 'clickToCursorOffset',
    'wrapText', 'wrapTextLines', 'measureText', 'measureTextDimensions', 'measureDecoratedText',
    'wrapAnsiNpmIncremental', 'wrapDecoratedLine', 'wrapHangLine', 'renderToScreen',
    'renderChildren', 'renderScrolledChildren', 'renderFrameSlice',
    'diffSpan', 'recordDraftEdit', 'setInput', 'stringWidth', 'stringWidthJavaScript', 'layoutNode',
    'renderNodeToOutput', 'render', 'onRender', 'calculateLayout', 'workLoopSync', 'performUnitOfWork',
    'beginWork', 'completeWork', 'commitRoot', 'flushSyncWorkAcrossRoots_impl',
    '(idle)', '(program)', '(garbage collector)',
  ])
  type CallFrame = { functionName: string; url?: string }
  type CpuProfile = { nodes: Array<{ id: number; children?: number[]; callFrame: CallFrame }>; samples?: number[]; startTime: number; endTime: number }
  // Only these static prefixes/package names are ever reported. The original
  // inspector URL is used transiently for matching and is never included in JSON.
  const sourceRoots = [
    ['ink', new URL('../src/ink/', import.meta.url).href],
    ['native-ts-yoga', new URL('../src/native-ts/', import.meta.url).href],
    ['terminal-utils', new URL('../src/terminal-utils/', import.meta.url).href],
    ['components', new URL('../src/components/', import.meta.url).href],
    ['screens', new URL('../src/screens/', import.meta.url).href],
    ['channel', new URL('../src/channel/', import.meta.url).href],
    ['dsh-adapter', new URL('../src/dsh-adapter/', import.meta.url).href],
  ] as const
  const classify = (frame: CallFrame): { key: string; kind: 'function' | 'module' } => {
    if (allowed.has(frame.functionName)) return { key: frame.functionName, kind: 'function' }
    const url = frame.url ?? ''
    for (const [label, prefix] of sourceRoots) if (url.startsWith(prefix)) return { key: `[module:${label}]`, kind: 'module' }
    if (/^(?:node:|internal\/)/.test(url)) return { key: '[module:node-internal-or-builtin]', kind: 'module' }
    if (/(?:^|\/)node_modules\/(?:react|react-dom|react-reconciler|scheduler)\//.test(url)) return { key: '[module:react-reconciler]', kind: 'module' }
    if (/(?:^|\/)node_modules\/marked\//.test(url)) return { key: '[module:marked]', kind: 'module' }
    if (/(?:^|\/)node_modules\/(?:cli-highlight|highlight\.js|escape-html|html-entities|entities|htmlparser2|domhandler|domutils|dom-serializer|parse5)\//.test(url)) return { key: '[module:highlight-escape]', kind: 'module' }
    if (/(?:^|\/)node_modules\/(?:wrap-ansi|strip-ansi|ansi-regex|ansi-styles|string-width|slice-ansi|get-east-asian-width|emoji-regex|chalk|@alcalzone\/ansi-tokenize)\//.test(url)) return { key: '[module:ansi-wrap-width]', kind: 'module' }
    if (url === '' || /^(?:wasm:|native\b)/.test(url)) return { key: '[module:native-or-anonymous]', kind: 'module' }
    return { key: '[module:other]', kind: 'module' }
  }
  const summarize = (profile: CpuProfile) => {
    const samples = profile.samples ?? []
    if (!samples.length) throw new Error('CPU profiler returned no samples')
    const nodes = new Map(profile.nodes.map(node => [node.id, node]))
    const parents = new Map<number, number>()
    for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
    const counts = new Map<string, { kind: 'function' | 'module'; selfSamples: number; inclusiveSamples: number }>()
    const bucket = (frame: CallFrame) => {
      const { key, kind } = classify(frame)
      const value = counts.get(key) ?? { kind, selfSamples: 0, inclusiveSamples: 0 }
      counts.set(key, value)
      return { key, value }
    }
    for (const id of samples) {
      const node = nodes.get(id)
      if (!node) throw new Error('CPU profile refers to an unknown sample node')
      bucket(node.callFrame).value.selfSamples++
      const seen = new Set<string>(), visited = new Set<number>()
      let cursor: number | undefined = id
      while (cursor !== undefined) {
        if (visited.has(cursor)) throw new Error('CPU profile contains a stack cycle')
        visited.add(cursor)
        const current = nodes.get(cursor)
        if (!current) throw new Error('CPU profile refers to an unknown stack node')
        const { key, value } = bucket(current.callFrame)
        if (!seen.has(key)) { value.inclusiveSamples++; seen.add(key) }
        cursor = parents.get(cursor)
      }
    }
    const items = [...counts].map(([functionName, count]) => ({ functionName, ...count }))
    return {
      sampleCount: samples.length, durationMs: (profile.endTime - profile.startTime) / 1000,
      samplingIntervalUs: 10_000,
      attribution: 'sample counts, not durations; inclusive counts each bucket at most once per stack; named functions merge by name; module buckets aggregate unknown functions by fixed URL class and are not exact functions',
      topSelf: [...items].sort((a, b) => b.selfSamples - a.selfSamples || b.inclusiveSamples - a.inclusiveSamples).slice(0, 15),
      topInclusive: [...items].sort((a, b) => b.inclusiveSamples - a.inclusiveSamples || b.selfSamples - a.selfSamples).slice(0, 15),
    }
  }
  let connected = false, enableAttempted = false, startAttempted = false
  let closePromise: Promise<ReturnType<typeof summarize> | undefined> | undefined
  return {
    async start() {
      session.connect(); connected = true
      enableAttempted = true
      await new Promise<void>((resolve, reject) => session.post('Profiler.enable', error => error ? reject(error) : resolve()))
      await new Promise<void>((resolve, reject) => session.post('Profiler.setSamplingInterval', { interval: 10_000 }, error => error ? reject(error) : resolve()))
      startAttempted = true
      await new Promise<void>((resolve, reject) => session.post('Profiler.start', error => error ? reject(error) : resolve()))
    },
    stop() {
      if (closePromise) return closePromise
      closePromise = (async () => {
        const failures: unknown[] = []
        let profile: CpuProfile | undefined
        if (connected && startAttempted) try {
          profile = await new Promise<CpuProfile>((resolve, reject) => session.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(result.profile as CpuProfile)))
        } catch (error) { failures.push(error) }
        if (connected && enableAttempted) try {
          await new Promise<void>((resolve, reject) => session.post('Profiler.disable', error => error ? reject(error) : resolve()))
        } catch (error) { failures.push(error) }
        if (connected) try { session.disconnect() } catch (error) { failures.push(error) }
        connected = false
        if (failures.length) throw new AggregateError(failures, 'CPU profiler cleanup failed')
        return profile ? summarize(profile) : undefined
      })()
      return closePromise
    },
  }
}

async function parentMain() {
  const { Terminal } = await import('@xterm/headless')
  const tempRoot = realpathSync(tmpdir())
  const scratch = mkdtempSync(join(tempRoot, 'dsh-external-input-'))
  const scratchReal = realpathSync(scratch)
  if (dirname(scratchReal) !== tempRoot || !basename(scratchReal).startsWith('dsh-external-input-')) throw new Error('unsafe scratch path')
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: scratchReal, USERPROFILE: scratchReal,
    NODE_ENV: 'production',
    XDG_CONFIG_HOME: join(scratchReal, 'config'), XDG_CACHE_HOME: join(scratchReal, 'cache'),
    XDG_DATA_HOME: join(scratchReal, 'data'), XDG_STATE_HOME: join(scratchReal, 'state'),
    TMPDIR: scratchReal, DSH_HOME: join(scratchReal, 'dsh'), DSH_TUI_LANG: 'zh', FORCE_COLOR: '3',
    MODE: config.mode, SMOOTH: config.smooth ? '1' : '0', PROFILE: config.profile ? '1' : '0', TRACE: config.trace ? '1' : '0', PRELOAD_HIGHLIGHT: config.preloadHighlight ? '1' : '0', TAIL_KIND: config.tailKind,
    TAIL_SIZE: String(config.tailSize), TURNS: String(config.turns), KEYS: String(config.keys),
    KEY_INTERVAL_MS: String(config.keyIntervalMs), STREAM_INTERVAL_MS: String(config.streamIntervalMs), TIMEOUT_MS: String(config.timeoutMs),
  }
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  type Sample = { index: number; key: string; scheduledMs: number; sentMs: number | null; sentNs?: string; scheduleDriftMs: number | null; observedMs: number | null; observedWrite: number | null; latencyMs: number | null; status: string; backpressure: boolean | null }
  const samples: Sample[] = Array.from({ length: config.keys }, (_, i) => ({ index: i + 1, key: alphabet[i]!, scheduledMs: i * config.keyIntervalMs, sentMs: null, scheduleDriftMs: null, observedMs: null, observedWrite: null, latencyMs: null, status: 'unsent', backpressure: null }))
  let child: ReturnType<typeof spawn> | undefined
  let exited = false, closed = false, spawnFailed = false, fatal = '', ready = false, verification: Record<string, unknown> | undefined
  let start = 0, parsed = 0, outputBytes = 0, backpressureCount = 0, markerVisible = false
  let transportEnded = false, transportBusy = false, transportDrained = false, transportFailed = false, unexpectedStdoutBytes = 0
  let transportError: string | null = null
  let transport: Readable | undefined, parserStopped = false, transportAborted = false
  let freezeSent = false
  let childTrace: ChildTrace | undefined, droppedCallbacks = 0
  let highlightPreload: Record<string, unknown> = { requested: config.preloadHighlight, status: config.preloadHighlight ? 'pending' : 'disabled', elapsedMs: null }
  const traceCallbacks: Array<{ writeIndex: number; timeNs: string }> = []
  const pulse = new EventEmitter()
  const childReaped = () => !child || exited || (spawnFailed && closed)
  const transportVerification = () => transportFailed ? 'failed' : transportDrained ? 'complete' : 'incomplete'
  const waitState = (predicate: () => boolean, ms: number) => waitFor(pulse, predicate, ms)
  // A timed-out child remains referenced: never claim it was reaped, never
  // unref it or delete its scratch. No polling; its OS handle keeps Node alive.
  const finishChild = async () => {
    const c = child
    if (!c) return
    if (!childReaped() && !await waitState(childReaped, 5000)) {
      c.kill('SIGTERM')
      if (!await waitState(childReaped, 2000)) {
        c.kill('SIGKILL')
        if (!await waitState(childReaped, 2000)) fatal ||= 'child exit not observed after SIGKILL; child remains tracked'
      }
    }
    // EOF and xterm callbacks have their own deadline even after child exit.
    if (!transportFailed && !transportDrained && !await waitState(() => transportDrained || transportFailed, 5000)) {
      fatal ||= 'framed output verification incomplete: drain deadline'
      parserStopped = true; transportAborted = true; transport?.destroy()
    }
    if (!await waitState(() => closed, 2000)) {
      fatal ||= 'child close deadline; closing owned pipes'
      parserStopped = true
      if (!transportDrained && !transportFailed) transportAborted = true
      for (const stream of c.stdio) stream?.destroy()
      if (c.connected) try { c.disconnect() } catch (error) { fatal ||= `IPC disconnect failed: ${String(error)}` }
      if (!await waitState(() => closed, 2000)) fatal ||= 'child close not observed after pipe destruction'
    }
  }
  const lines = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '')
  const inspect = () => {
    const now = performance.now()
    const b = term.buffer.active
    const line = b.getLine(b.baseY + b.cursorY)
    // Keys are ASCII and constrained to fit on a single line. Only accept an
    // exact cumulative suffix ending at the active cursor, never transcript text.
    let preceding = ''
    for (let x = 0; x < b.cursorX; x++) preceding += line?.getCell(x)?.getChars() || ' '
    for (let n = samples.length; n > 0; n--) {
      if (samples[n - 1]!.sentMs === null || !preceding.endsWith(alphabet.slice(0, n))) continue
      for (let i = 0; i < n; i++) {
        const sample = samples[i]!
        if (sample.sentMs === null || sample.observedMs !== null) continue
        sample.observedMs = now - start
        sample.observedWrite = parsed
        sample.latencyMs = sample.observedMs - sample.sentMs
        sample.status = sample.latencyMs <= config.timeoutMs ? 'observed' : 'late'
      }
      break
    }
    if (freezeSent && lines().some(line => line.includes('EXTTAILMARKER'))) markerVisible = true
  }
  const reportSamples = () => config.trace ? samples.map(({ key: _key, ...sample }) => sample) : samples
  const buildTrace = () => {
    if (!config.trace) return undefined
    const ns = (value: unknown): bigint | undefined => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : undefined
    const ms = (later: bigint, earlier: bigint) => Number(later - earlier) / 1e6
    const events = childTrace?.entries ?? []
    const childWrites = new Map<number, bigint>()
    const reads: Array<{ at: bigint; unreadBytes: number }> = []
    for (const entry of events) {
      const at = ns(entry.timeNs)
      if (at === undefined) continue
      if (entry.kind === 'write') childWrites.set(entry.writeIndex, at)
      else if (entry.kind === 'readable' && entry.unreadBytes > 0) reads.push({ at, unreadBytes: entry.unreadBytes })
    }
    const callbacks = new Map<number, bigint>()
    for (const entry of traceCallbacks) { const at = ns(entry.timeNs); if (at !== undefined) callbacks.set(entry.writeIndex, at) }
    const perKey = samples.map(sample => {
      const sent = ns(sample.sentNs)
      const childWrite = sample.observedWrite === null ? undefined : childWrites.get(sample.observedWrite)
      const callback = sample.observedWrite === null ? undefined : callbacks.get(sample.observedWrite)
      const missing: string[] = []
      if (sent === undefined) missing.push('unsent')
      if (sample.observedWrite === null) missing.push('no-observed-write')
      if (sample.observedWrite !== null && childWrite === undefined) missing.push('child-write-not-retained')
      if (sample.observedWrite !== null && callback === undefined) missing.push('callback-not-retained')
      const ordered = childWrite !== undefined && callback !== undefined && callback >= childWrite && (sent === undefined || childWrite >= sent)
      if (childWrite !== undefined && callback !== undefined && callback < childWrite) missing.push('write-callback-clock-order')
      const candidate = sent !== undefined && childWrite !== undefined && childWrite >= sent
        ? reads.find(read => read.at >= sent && read.at <= childWrite) : undefined
      if (!candidate && sent !== undefined) missing.push('no-temporal-readable-candidate')
      if (sent !== undefined && childWrite !== undefined && childWrite < sent) missing.push('write-before-send')
      return { index: sample.index, observedWrite: sample.observedWrite, sentNs: sample.sentNs ?? null,
        firstReadableAfterSendNs: candidate?.at.toString() ?? null, unreadBytes: candidate?.unreadBytes ?? null,
        firstReadableAfterSendMs: candidate && sent !== undefined ? ms(candidate.at, sent) : null,
        childWriteNs: childWrite?.toString() ?? null, xtermCallbackNs: callback?.toString() ?? null,
        childWriteToXtermMs: ordered ? ms(callback!, childWrite!) : null, missing }
    })
    const summarize = (values: number[]) => {
      values.sort((a, b) => a - b)
      const p = (q: number) => values.length ? values[Math.ceil(values.length * q) - 1] : null
      return { n: values.length, missing: samples.length - values.length, p50: p(.5), p95: p(.95), p99: p(.99), max: p(1) }
    }
    return { clock: 'same-host process.hrtime.bigint monotonic nanoseconds',
      limitation: 'TRACE changes scheduling, framing and IPC costs; diagnosis only, not a latency gate. First readable after send is a temporal candidate, not proof that the particular key was present, read or handled; bytes and events can coalesce.',
      childReceived: childTrace !== undefined, child: childTrace ?? null, parentCallbacks: traceCallbacks,
      droppedParentCallbacks: droppedCallbacks, truncated: !childTrace || childTrace.droppedReadable > 0 || childTrace.droppedWrites > 0 || droppedCallbacks > 0,
      firstReadableAfterSendMs: summarize(perKey.flatMap(item => item.firstReadableAfterSendMs === null ? [] : [item.firstReadableAfterSendMs])),
      childWriteToXtermMs: summarize(perKey.flatMap(item => item.childWriteToXtermMs === null ? [] : [item.childWriteToXtermMs])), perKey }
  }
  let signal = ''
  const onSignal = (s: string) => { signal = s; fatal ||= `parent received ${s}`; child?.kill('SIGTERM'); pulse.emit('change') }
  const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM')
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
  try {
    child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(import.meta.url), '--child'], { cwd: scratchReal, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc', 'pipe'] })
    const c = child
    c.on('error', error => { if (c.pid === undefined) spawnFailed = true; fatal ||= `child process: ${error.message}`; pulse.emit('change') })
    c.on('exit', (code, sig) => { exited = true; if (code !== 0 || sig) fatal ||= `child exit code=${code} signal=${sig}`; pulse.emit('change') })
    c.on('close', () => { closed = true; pulse.emit('change') })
    c.stdin!.on('error', error => { fatal ||= `stdin: ${error.message}`; pulse.emit('change') })
    c.stderr!.on('data', data => { process.stderr.write(data) })
    // Ordinary stdout is deliberately separate: unframed output cannot be
    // safely inserted into the ordered measured stream or silently ignored.
    c.stdout!.on('data', (data: Buffer) => { unexpectedStdoutBytes += data.length; fatal ||= 'unexpected unframed child stdout'; c.kill('SIGTERM'); pulse.emit('change') })
    transport = c.stdio[4] as Readable
    const framed = transport
    const header = Buffer.allocUnsafe(4)
    let headerBytes = 0, payloadBytes = 0, payload: Buffer | undefined
    let remainder: Buffer | undefined, remainderOffset = 0
    const failTransport = (reason: string) => {
      if (transportFailed || transportAborted) return
      transportFailed = true; transportError = reason; parserStopped = true
      fatal ||= `framed output: ${reason}`
      framed.destroy(); c.kill('SIGTERM'); pulse.emit('change')
    }
    const finishTransportIfComplete = () => {
      // EOF may precede xterm's callback for the last complete frame. Only
      // classify truncation after that callback has drained all buffered bytes.
      if (!transportEnded || transportBusy || remainder || transportFailed || parserStopped) return
      if (headerBytes || payload !== undefined) {
        failTransport(`truncated final frame (header=${headerBytes}, payload=${payloadBytes})`)
        return
      }
      transportDrained = true
      pulse.emit('change')
    }
    // Parse incrementally, buffering at most one bounded payload and one pipe
    // read. A callback for EVERY original _write precedes parsing the next.
    const drive = () => {
      if (parserStopped || transportFailed || transportBusy) return
      try {
        while (remainder && remainderOffset < remainder.length) {
          if (!payload) {
            const n = Math.min(4 - headerBytes, remainder.length - remainderOffset)
            remainder.copy(header, headerBytes, remainderOffset, remainderOffset + n)
            remainderOffset += n; headerBytes += n
            if (headerBytes < 4) continue
            const length = header.readUInt32BE(0)
            if (length > MAX_FRAME_BYTES) return failTransport(`invalid length ${length}`)
            payload = Buffer.allocUnsafe(length); payloadBytes = 0; headerBytes = 0
          }
          const n = Math.min(payload.length - payloadBytes, remainder.length - remainderOffset)
          remainder.copy(payload, payloadBytes, remainderOffset, remainderOffset + n)
          remainderOffset += n; payloadBytes += n
          if (payloadBytes === payload.length) {
            const complete = payload
            payload = undefined; payloadBytes = 0; transportBusy = true
            outputBytes += complete.length
            term.write(complete, () => {
              transportBusy = false
              if (!parserStopped) {
                parsed++
                if (config.trace) {
                  if (traceCallbacks.length < TRACE_SIDE_LIMIT) traceCallbacks.push({ writeIndex: parsed, timeNs: process.hrtime.bigint().toString() })
                  else droppedCallbacks++
                }
                inspect(); pulse.emit('change'); drive()
              }
            })
            return
          }
        }
        remainder = undefined; remainderOffset = 0
        if (transportEnded) finishTransportIfComplete()
        else framed.resume()
      } catch (error) { failTransport(String(error)) }
    }
    framed.on('data', (data: Buffer) => {
      framed.pause()
      if (remainder || data.length > MAX_FRAME_BYTES + 4) return failTransport('oversized or overlapping transport chunk')
      remainder = data; remainderOffset = 0; drive()
    })
    framed.on('end', () => {
      transportEnded = true
      finishTransportIfComplete()
      pulse.emit('change')
    })
    framed.on('error', error => failTransport(error.message))
    framed.on('close', () => { if (!transportEnded && !transportFailed && !transportAborted) failTransport('pipe closed before EOF'); pulse.emit('change') })
    c.on('message', (message: unknown) => {
      const m = message as { type?: string; data?: Record<string, unknown>; error?: string }
      if (m.type === 'ready') ready = true
      if (m.type === 'verification') verification = m.data
      if (config.trace && m.type === 'trace') childTrace = m.data as ChildTrace
      if (config.preloadHighlight && m.type === 'highlight-preload' && m.data) highlightPreload = m.data
      if (m.type === 'error') fatal ||= `child: ${m.error}`
      pulse.emit('change')
    })
    const waitUntil = (predicate: () => boolean, ms: number, failFast = true) =>
      waitFor(pulse, predicate, ms, () => failFast && (exited || Boolean(fatal)))
    if (!await waitUntil(() => ready && parsed > 0, 15000)) throw new Error(fatal || 'child readiness timeout')
    start = performance.now() + 100
    for (const sample of samples) {
      const delay = start + sample.scheduledMs - performance.now()
      if (delay > 0) await sleep(delay) // 固定窗:pacing 按绝对时钟发键
      if (exited || fatal || !c.stdin!.writable) break
      sample.sentMs = performance.now() - start
      sample.scheduleDriftMs = sample.sentMs - sample.scheduledMs
      sample.status = 'pending'
      if (config.trace) sample.sentNs = process.hrtime.bigint().toString()
      sample.backpressure = !c.stdin!.write(sample.key)
      if (sample.backpressure) backpressureCount++
    }
    // Wait until each sent key was observed or its own deadline elapsed.
    await waitUntil(() => samples.every(s => s.sentMs === null || s.observedMs !== null || performance.now() - start - s.sentMs >= config.timeoutMs), config.timeoutMs + 1000)
    for (const s of samples) if (s.status === 'pending') s.status = 'timeout'
    if (!exited && c.connected) { freezeSent = true; markerVisible = lines().some(line => line.includes('EXTTAILMARKER')); c.send({ type: 'freeze', expectedDraft: alphabet.slice(0, config.keys) }) }
    await waitUntil(() => verification !== undefined && markerVisible, Math.min(60000, config.timeoutMs * 3))
    const screen = lines()
    const allHistoryVisible = Array.from({ length: config.turns }, (_, i) => i + 1).every(turn =>
      screen.some(line => new RegExp(`synthetic question ${turn}(?![0-9])`).test(line)) && screen.some(line => new RegExp(`synthetic answer ${turn}(?![0-9])`).test(line)))
    // One last pass after stream completion; do not relabel expired samples as
    // successful if their first visible observation arrived after their deadline.
    if (!exited && c.connected) c.send({ type: 'shutdown' })
    await finishChild()
    if (!transportDrained) fatal ||= 'framed output did not fully drain'
    const valid = samples.filter(s => s.status === 'observed').map(s => s.latencyMs!)
    const percentile = (p: number) => valid.length ? [...valid].sort((a, b) => a - b)[Math.ceil(valid.length * p) - 1] : null
    const history = verification?.history as { sourceHistoryExact?: boolean; railIndexComplete?: boolean; allHistoryProjected?: boolean; latestTurnProjected?: boolean } | undefined
    // Conservative success: collapsed historical answers are not verified by a
    // rail index; report failure rather than presenting incomplete projection as success.
    const inputSamplesValid = !fatal && verification?.reactMode === 'production' && samples.every(s => s.status === 'observed') && verification?.draftExact === true
    const ok = inputSamplesValid && history?.sourceHistoryExact === true && history?.railIndexComplete === true && history?.allHistoryProjected === true && history?.latestTurnProjected === true && verification?.streamExact === true && markerVisible && (config.mode === 'idle' || (typeof verification?.chunksDuringInput === 'number' && verification.chunksDuringInput > 0))
    console.log(JSON.stringify({ fixture: 'external-clock-real-dsh-synthetic-host', config, ok, inputSamplesValid, fatal: fatal || null, signal: signal || null,
      n: samples.length, sent: samples.filter(s => s.sentMs !== null).length, onTime: valid.length,
      timeout: samples.filter(s => s.status === 'timeout' || s.status === 'late').length, unsent: samples.filter(s => s.status === 'unsent').length,
      latencyMs: { denominator: valid.length, population: 'on-time observed only', p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: percentile(1) },
      samples: reportSamples(), ...(config.trace ? { trace: buildTrace() } : {}), highlightPreload, outputBytes, parsedWrites: parsed, transportEnded, transportVerification: transportVerification(), transportError, childReaped: childReaped(), childClosed: closed, scratchRetained: Boolean(child && (!childReaped() || !closed)), unexpectedStdoutBytes, stdinBackpressure: backpressureCount, markerVisible, allHistoryVisible, verification: verification ?? null,
      writeBoundary: 'BE32-framed original Out._write calls, each parsed and inspected separately; includes control/startup/shutdown writes, not exclusively diff frames',
      successDefinition: 'all keys on time; exact draft, source history, rail index, every projected history turn and tail projection; tail marker painted; streaming has input-overlap chunks. A false allHistoryVisible is reported separately: a viewport cannot contain an arbitrarily long history.',
      limitation: 'framing copies writes and adds parser/header cost and pipe backpressure; pipe/headless xterm is not a physical terminal or IME; independent event loop captures child pre-send blocking, not parent pre-send scheduling or OS/display latency' }))
    if (!ok) process.exitCode = 1
  } catch (error) {
    fatal ||= String(error)
    // Early failures still allow EOF and callbacks to finish under deadlines.
    await finishChild()
    // Even startup failures produce all planned samples and explicit missing data.
    for (const sample of samples) if (sample.status === 'pending') sample.status = 'timeout'
    const valid = samples.filter(s => s.status === 'observed').map(s => s.latencyMs!).sort((a, b) => a - b)
    const percentile = (p: number) => valid.length ? valid[Math.ceil(valid.length * p) - 1] : null
    console.log(JSON.stringify({ fixture: 'external-clock-real-dsh-synthetic-host', config, ok: false, inputSamplesValid: false, fatal, n: samples.length, sent: samples.filter(s => s.sentMs !== null).length, onTime: valid.length, timeout: samples.filter(s => s.status === 'timeout' || s.status === 'late').length, unsent: samples.filter(s => s.status === 'unsent').length, latencyMs: { denominator: valid.length, population: 'on-time observed only', p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: percentile(1) }, samples: reportSamples(), ...(config.trace ? { trace: buildTrace() } : {}), highlightPreload, transportEnded, transportVerification: transportVerification(), transportError, childReaped: childReaped(), childClosed: closed, scratchRetained: Boolean(child && (!childReaped() || !closed)), verification: verification ?? null }))
    process.exitCode = 1
  } finally {
    parserStopped = true
    term.dispose()
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
    // Never remove scratch until the owned child has exited/reaped and closed;
    // an unreaped child remains referenced, and the report names this retention.
    if (!child || (childReaped() && closed)) {
      if (realpathSync(scratch) !== scratchReal || dirname(scratchReal) !== tempRoot) throw new Error('scratch path changed; refusing cleanup')
      rmSync(scratchReal, { recursive: true, force: true })
    }
  }
}

async function childMain() {
  // The parent's whitelist env is already isolated before any application import.
  const scratch = process.env.HOME!
  const ttyFd = openSync(join(scratch, 'tty-output'), 'w')
  const frameOutput = createWriteStream('', { fd: 4, autoClose: true })
  let interval: ReturnType<typeof setInterval> | undefined
  let profiler: Awaited<ReturnType<typeof createCpuProfiler>> | undefined
  const traceEntries: TraceEntry[] = []
  let droppedReadable = 0, droppedWrites = 0
  const recordTrace = (entry: TraceEntry) => {
    if (traceEntries.length < TRACE_SIDE_LIMIT) traceEntries.push(entry)
    else if (entry.kind === 'readable') droppedReadable++
    else droppedWrites++
  }
  const tell = (message: unknown) => { if (process.connected) process.send?.(message) }
  frameOutput.on('error', error => { tell({ type: 'error', error: `framed pipe: ${error.message}` }); process.exitCode = 1 })
  try {
    if (process.env.NODE_ENV !== 'production') throw new Error('child must load the default production React build')
    const [React, { render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel }, { mountChannelUi }, { registerTuiChannel }, { bindChannelCommands }] = await Promise.all([
      import('react'), import('../src/ui.js'), import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'),
      import('../src/dsh-adapter/channel.js'), import('../src/dsh-adapter/channel-ui.js'), import('../src/adapter/channel/host-registry.js'), import('../src/dsh-adapter/channel/commands.js'),
    ])
    if (config.preloadHighlight) {
      const start = performance.now()
      try {
        const { getCliHighlightPromise } = await import('../src/terminal-utils/cliHighlight.js')
        if (!await getCliHighlightPromise()) throw new Error('unavailable')
        tell({ type: 'highlight-preload', data: { requested: true, status: 'loaded', elapsedMs: performance.now() - start, limitation: 'await duration before mount and measurement; may be a cache hit; moving this cost is not a product fix' } })
      } catch {
        tell({ type: 'highlight-preload', data: { requested: true, status: 'failed', elapsedMs: performance.now() - start } })
        throw new Error('highlight preload failed or returned null')
      }
    }
    type RawEvent = { type: string; seq: number; time: number; data: Record<string, unknown> }
    let seq = 0
    const events: RawEvent[] = []
    const unit = config.tailKind === 'plain' ? 'plain text ' : config.tailKind === 'rich' ? '**bold** [link](https://example.invalid) `code` ' : 'const value = 42; // synthetic\n'
    const prefix = config.tailKind === 'fence' ? '```ts\n' : ''
    const seed = prefix + unit.repeat(Math.ceil(config.tailSize / unit.length)).slice(0, config.tailSize)
    const event = (type: string, data: Record<string, unknown>): RawEvent => ({ type, seq: ++seq, time: seq, data })
    for (let turn = 1; turn <= config.turns; turn++) {
      events.push(event('user/message', { id: `synthetic-user-${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text: `synthetic question ${turn}` }] }))
      events.push(event('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `synthetic answer ${turn}` }] } }))
    }
    const historySnapshot = JSON.stringify(events)
    if (config.mode === 'idle') events.push(event('assistant/message', { turn: config.turns + 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `${seed}\nEXTTAILMARKER` }] } }))
    const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>()
    const cleanups: (() => void)[] = []
    const agent = { id: 'synthetic-agent', status: 'idle', session: { id: 'synthetic-session', seq, events, header: { cwd: scratch } }, ctx: { on: () => () => undefined }, followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true } }
    const services: Record<string, unknown> = {
      settings: { describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: {}, value: {} }, { ns: 'dsh-tui', revision: 1, user: {}, value: { recapOnOpen: false } }], get: () => ({}), mutate: async () => undefined },
      credentials: { resolve: async () => undefined, set: async () => { throw new Error('credentials forbidden') }, unset: async () => { throw new Error('credentials forbidden') } },
      llm: { listConfigurableProviders: () => [], discoverModels: async () => [] },
      agents: { create: async () => { throw new Error('create forbidden') }, resume: async () => { throw new Error('resume forbidden') } },
    }
    const ctx = {
      on(name: string, callback: (...args: unknown[]) => unknown) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => { set.delete(callback) } },
      effect(setup: () => () => void) { cleanups.push(setup()) }, get(name: string) { return services[name] }, logger: { warn() {} },
    }
    const raw = createChannel(ctx as never, agent as never, { model: 'synthetic', provider: 'synthetic', cwd: scratch, activity: false, whale: false, whaleIdle: false, minimalUi: true, smoothStreaming: config.smooth })
    const unregister = registerTuiChannel(ctx, raw)
    const mount = mountChannelUi(ctx, raw, undefined, 'new')
    bindChannelCommands(raw, mount.channel)
    if (mount.channel.smoothStreaming !== config.smooth) throw new Error('smooth configuration mismatch')
    let writes = 0, chunks = 0, chunksDuringInput = 0, firstInput = false, revision = 0, expected = '', frameCount = 0, notifications = 0
    let framePressureWindow = false, frameFalseTotal = 0, frameMaxQueuedTotal = 0, frameFalseWindow = 0, frameMaxQueuedWindow = 0
    const pulse = new EventEmitter()
    const unsubscribe = mount.channel.subscribe(() => { notifications++; pulse.emit('change') })
    const deliver = (name: string, ...args: unknown[]) => {
      const handlers = [...(listeners.get(name) ?? [])]
      if (!handlers.length) throw new Error(`missing handler ${name}`)
      for (const handler of handlers) handler(...args)
    }
    const appendEvent = (type: string, data: Record<string, unknown>) => {
      const item = event(type, data); agent.session.seq = item.seq; events.push(item); deliver('session/event', agent.session, item)
    }
    const sendFrame = (frame: Record<string, unknown>) => deliver('agent/assistant-stream', { agent, frame })
    const push = (text: string) => { const index = chunks++; if (firstInput) chunksDuringInput++; expected += text; sendFrame({ type: 'chunk', revision: ++revision, attemptId: 'synthetic-attempt', index, time: Date.now(), chunk: { type: 'text-delta', index: 0, text } }) }
    // Each _write is a separate BE32 length + payload record on fd 4. The
    // callback follows the async pipe write, never a parent/xterm round-trip.
    // Ink's synchronous unmount writes use fd, an owned temporary file; they
    // are outside the measured window and never mixed into this framed stream.
    class Out extends Writable {
      columns = COLS; rows = ROWS; isTTY = true; fd = ttyFd
      override write(chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
        if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw new TypeError('unsupported Ink output chunk')
        const length = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk.byteLength
        if (length > MAX_FRAME_BYTES || this.writableLength + length > 2 * MAX_FRAME_BYTES) throw new Error('bounded Ink output queue exceeded')
        return typeof encoding === 'function' ? super.write(chunk, encoding) : super.write(chunk, encoding, callback)
      }
      override _write(data: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
        if (data.length > MAX_FRAME_BYTES) return done(new Error(`output write exceeds ${MAX_FRAME_BYTES} bytes`))
        writes++
        if (config.trace) {
          if (traceEntries.length < TRACE_SIDE_LIMIT) recordTrace({ kind: 'write', writeIndex: writes, timeNs: process.hrtime.bigint().toString() })
          else droppedWrites++
        }
        const record = Buffer.allocUnsafe(data.length + 4)
        record.writeUInt32BE(data.length, 0); data.copy(record, 4)
        const accepted = frameOutput.write(record, done)
        const queued = frameOutput.writableLength
        if (!accepted) frameFalseTotal++
        frameMaxQueuedTotal = Math.max(frameMaxQueuedTotal, queued)
        if (framePressureWindow) {
          if (!accepted) frameFalseWindow++
          frameMaxQueuedWindow = Math.max(frameMaxQueuedWindow, queued)
        }
      }
    }
    const stdout = new Out()
    stdout.on('error', error => { tell({ type: 'error', error: `Ink output: ${error.message}` }); process.exitCode = 1 })
    const stdin = Object.assign(process.stdin, { isTTY: true, setRawMode() { return this } })
    // Observe readiness without reading: Ink's own readable handler remains the
    // only consumer, and adding a data listener must not switch stdin to flowing mode.
    stdin.on('readable', () => {
      const unreadBytes = stdin.readableLength
      if (config.trace) {
        if (traceEntries.length < TRACE_SIDE_LIMIT) recordTrace({ kind: 'readable', timeNs: process.hrtime.bigint().toString(), unreadBytes })
        else droppedReadable++
      }
      if (unreadBytes > 0) firstInput = true
    })
    const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
    const controller: { current: { text(): string } | null } = { current: null }
    const app = await render(<AlternateScreen><Chat channel={mount.channel} questionStore={new QuestionStore()} fullscreen trajectorySeen promptControllerRef={controller as never} /></AlternateScreen>, { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, exitOnCtrlC: false, patchConsole: false, onFrame: () => { frameCount++; pulse.emit('change') } })
    try {
      // Effects installing the controller may run just after the first frame.
      setImmediate(() => pulse.emit('change'))
      if (!await waitFor(pulse, () => Boolean(controller.current && writes && listeners.get('agent/assistant-stream')?.size), 10000)) throw new Error('child composer not ready')
      await sleep(1000) // 固定窗:pacing 固定预热，减少启动帧对对比的影响
      let profileStartedAt: number | undefined
      if (config.profile) {
        profiler = await createCpuProfiler()
        await profiler.start()
        profileStartedAt = performance.now()
      }
      if (config.mode === 'stream') {
        appendEvent('turn/start', { turn: config.turns + 1 })
        appendEvent('step/start', { turn: config.turns + 1, step: 1 })
        sendFrame({ type: 'start', revision: ++revision, attemptId: 'synthetic-attempt', turn: config.turns + 1, step: 1 })
        if (seed) push(seed)
        interval = setInterval(() => push(' x'), config.streamIntervalMs)
      }
      // Broad child-side window, not per-key timing or a CPU profile. It starts
      // before the ready IPC and includes the parent's ~100 ms pre-key delay.
      const cpuStart = process.cpuUsage()
      const eluStart = performance.eventLoopUtilization()
      const observationStart = performance.now()
      framePressureWindow = true
      tell({ type: 'ready' })
      await new Promise<void>((resolve, reject) => {
        process.on('disconnect', resolve)
        process.on('message', async (message: unknown) => {
          const m = message as { type?: string; expectedDraft?: string }
          if (m.type === 'shutdown') resolve()
          if (m.type !== 'freeze') return
          try {
            const cpu = process.cpuUsage(cpuStart)
            const elu = performance.eventLoopUtilization(eluStart)
            const observationWindow = { elapsedMs: performance.now() - observationStart, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, eventLoopActiveMs: elu.active, eventLoopIdleMs: elu.idle, eventLoopUtilization: elu.utilization, limitation: 'child ready-to-freeze, includes pre-key delay and waits; not a CPU profile, ELU alone does not establish cause' }
            framePressureWindow = false
            const frameOutputBackpressure = { window: 'child ready-to-freeze', writeReturnedFalse: frameFalseWindow, maxWritableLengthBytes: frameMaxQueuedWindow, sinceChildStartThroughFreeze: { writeReturnedFalse: frameFalseTotal, maxWritableLengthBytes: frameMaxQueuedTotal }, limitation: 'Node writableLength sampled after frameOutput.write, including the 4-byte header; excludes kernel pipe and separately buffered Ink writes; false indicates a high-water mark, not proven parent causality' }
            if (interval) { clearInterval(interval); interval = undefined }
            const beforeMarkerChunksDuringInput = chunksDuringInput
            const stopRequestedAt = performance.now()
            const summary = profiler ? await profiler.stop() : undefined
            if (config.profile && !summary) throw new Error('CPU profiler did not return a profile')
            const cpuProfile = summary ? { ...summary, startsBeforeReadyMs: observationStart - profileStartedAt!, stopRequestedAfterReadyMs: stopRequestedAt - observationStart, window: 'started before synthetic stream setup/seed; stopped after freeze stopped stream production', limitation: 'sampling perturbs timings; attribution only, not an A/B latency threshold' } : undefined
            if (config.mode === 'stream') push('\nEXTTAILMARKER')
            // Settled assistant blocks use textOfBlocks(), which trims their
            // outer whitespace; streamed deltas retain their exact content.
            const idleText = `${seed}\nEXTTAILMARKER`.trim()
            const projected = () => config.mode === 'idle'
              ? mount.channel.rows.some(row => row.kind === 'assistant' && row.text === idleText)
              : mount.channel.rows.some(row => row.kind === 'assistant' && row.streaming === true && row.text === expected)
            await waitFor(pulse, projected, Math.min(8000, config.timeoutMs))
            const draft = controller.current?.text() ?? ''
            const streamExact = projected()
            const rows = mount.channel.rows
            const projectedTurn = (turn: number) => rows.some(row => row.kind === 'user' && row.text === `synthetic question ${turn}`) && rows.some(row => row.kind === 'assistant' && row.text === `synthetic answer ${turn}`)
            const projectedTurns = Array.from({ length: config.turns }, (_, i) => i + 1).filter(projectedTurn)
            const indexedSeqs = new Set(rows.flatMap(row => [ ...(row.kind === 'user' && row.seq !== undefined ? [row.seq] : []), ...(row.collapsedTurns ?? []).map(turn => turn.seq) ]))
            const indexedTurns = Array.from({ length: config.turns }, (_, i) => 2 * i + 1).filter(seq => indexedSeqs.has(seq)).length
            const sourceHistoryExact = JSON.stringify(events.slice(0, config.turns * 2)) === historySnapshot
            const allHistoryProjected = projectedTurns.length === config.turns
            tell({ type: 'verification', data: { reactMode: process.env.NODE_ENV, draftExact: draft === m.expectedDraft, draftLength: draft.length, expectedDraftLength: m.expectedDraft?.length,
              history: { sourceHistoryExact, sourceEvents: config.turns * 2, indexedTurns, railIndexComplete: indexedTurns === config.turns, projectedTurns: projectedTurns.length, allHistoryProjected, latestTurnProjected: config.turns === 0 || projectedTurn(config.turns), collapsedSections: rows.filter(row => row.collapsed).length,
                limitation: 'collapsedTurns are rail metadata, not projected transcript text; full collapsed history is not verified' },
              streamExact, expectedStreamLength: config.mode === 'idle' ? idleText.length : expected.length, chunksDuringInput: beforeMarkerChunksDuringInput, notifications, frameCount, observationWindow, frameOutputBackpressure, ...(cpuProfile ? { cpuProfile } : {}), tailKind: config.tailKind, tailSize: config.tailSize } })
          } catch (error) { reject(error) }
        })
      })
    } finally {
      if (interval) clearInterval(interval)
      // Stop sampling even when the input window aborts before freeze; do this
      // before unmount, which can itself block on output backpressure.
      if (profiler) try { await profiler.stop() } catch (error) { tell({ type: 'error', error: `CPU profiler cleanup: ${String(error)}` }); process.exitCode = 1 }
      try {
        await app.unmount()
        stdout.end()
        await finished(stdout)
      } finally {
        unsubscribe(); mount.dispose(); unregister()
        for (const cleanup of [...cleanups].reverse()) cleanup()
      }
    }
  } catch (error) {
    tell({ type: 'error', error: String(error) })
    process.exitCode = 1
  } finally {
    // Idempotent: also covers disconnect, render failure and partial startup.
    if (profiler) try { await profiler.stop() } catch (error) { tell({ type: 'error', error: `CPU profiler cleanup: ${String(error)}` }); process.exitCode = 1 }
    frameOutput.end()
    try { await finished(frameOutput) } catch (error) { tell({ type: 'error', error: `framed pipe completion: ${String(error)}` }); process.exitCode = 1 }
    if (config.trace) tell({ type: 'trace', data: { entries: traceEntries, droppedReadable, droppedWrites } satisfies ChildTrace })
    closeSync(ttyFd)
    if (process.connected) process.disconnect()
  }
}
