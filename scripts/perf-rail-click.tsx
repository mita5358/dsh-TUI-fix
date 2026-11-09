/**
 * perf-rail-click — click an unloaded tick in the full turn index and measure
 * click → chunk materialized → exact target landed, on a representative
 * 124+ chunk session (real DSH channel, production Chat, headless xterm).
 *
 * The fixture matches the installed-package shape of a real long session:
 * ~124 char-bound chunks over ~370 rounds (3 rounds per chunk at 320KB each,
 * mostly tool output), so every old chunk is a single digest row and the rail
 * shows only a window of ticks — the exact situation reported as "clicking an
 * index link is slow".
 *
 * Heavy synthetic probe: do not run without explicit authorization and an
 * audited clean launcher. Loader/preloads execute before the guards below;
 * those guards do not enforce network or native-child isolation.
 * Illustrative entry (NOT an isolated launcher):
 * NODE_ENV=production node --import tsx/esm scripts/perf-rail-click.tsx
 * Env: ROUNDS=372 CLICKS=8 ASSISTANT_KB=130 RESULT_KB=200 TRACE=1
 */
import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

// This is necessary, not proof: JSX imports can run before the module body,
// and a preload or custom loader can still select an unexpected React build.
if (process.env.NODE_ENV !== 'production' || process.env.DSH_TUI_REACT_DEV === '1') {
  throw new Error('set NODE_ENV=production before starting; DSH_TUI_REACT_DEV=1 is unsupported')
}
if (process.env.NODE_OPTIONS) throw new Error('unset NODE_OPTIONS before starting this synthetic probe')

const tempRoot = realpathSync(tmpdir())
const parentIdentity = lstatSync(tempRoot, { bigint: true })
const scratch = mkdtempSync(join(tempRoot, 'dsh-rail-perf-'))
// Failures before the render try/finally retain this not-yet-verified path.
console.error(`SCRATCH-CREATED ${scratch}`)
const scratchIdentity = lstatSync(scratch, { bigint: true })
const verifyScratch = (): void => {
  const parent = lstatSync(tempRoot, { bigint: true })
  const current = lstatSync(scratch, { bigint: true })
  if (
    !parent.isDirectory() || parent.dev !== parentIdentity.dev || parent.ino !== parentIdentity.ino ||
    dirname(scratch) !== tempRoot || !basename(scratch).startsWith('dsh-rail-perf-') ||
    realpathSync(scratch) !== scratch || !current.isDirectory() ||
    current.dev !== scratchIdentity.dev || current.ino !== scratchIdentity.ino ||
    current.uid !== scratchIdentity.uid || current.mode !== scratchIdentity.mode ||
    (process.platform !== 'win32' &&
      (typeof process.getuid !== 'function' || current.uid !== BigInt(process.getuid()) || (current.mode & 0o077n) !== 0n))
  ) throw new Error(`refusing unsafe scratch path: ${scratch}`)
}
// Validate before the first write as well as immediately before cleanup.
verifyScratch()
const tracePath = join(scratch, 'geometry.jsonl')
writeFileSync(tracePath, '')
// The loader and static imports run earlier: invoke this probe with a clean
// environment as well. These assignments only constrain later application
// imports and do not provide network or native-child isolation.
for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('DSH_TUI_')) delete process.env[key]
process.env.HOME = join(scratch, 'home')
process.env.USERPROFILE = process.env.HOME
process.env.DSH_HOME = join(scratch, 'dsh-home')
process.env.XDG_CONFIG_HOME = join(scratch, 'config')
process.env.XDG_CACHE_HOME = join(scratch, 'cache')
process.env.XDG_DATA_HOME = join(scratch, 'data')
process.env.XDG_STATE_HOME = join(scratch, 'state')
process.env.XDG_RUNTIME_DIR = join(scratch, 'runtime')
process.env.TMPDIR = join(scratch, 'tmp')
process.env.TMP = process.env.TMPDIR
process.env.TEMP = process.env.TMPDIR
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR
delete process.env.TMUX
delete process.env.STY
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
if (process.env.TRACE === '1') process.env.DSH_TUI_GEOMETRY_TRACE = tracePath
mkdirSync(process.env.HOME, { recursive: true })
mkdirSync(process.env.TMPDIR, { recursive: true })
mkdirSync(process.env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 })

const ROUNDS = Number(process.env.ROUNDS ?? 372)
const CLICKS = Number(process.env.CLICKS ?? 8)
const ASSISTANT_KB = Number(process.env.ASSISTANT_KB ?? 130)
const RESULT_KB = Number(process.env.RESULT_KB ?? 200)
/** Tool calls per round: real turns interleave many small results, not one big
 *  blob; the total result bytes per round stay constant when this changes. */
const CALLS = Math.max(1, Number(process.env.CALLS ?? 1))
/** Source lines in each terminal command. Real long sessions carry pasted
 *  heredocs and `bash -lc '…'` scripts; 1 keeps the historical single-line
 *  fixture, >1 weighs the header fold. */
const CMD_LINES = Math.max(1, Number(process.env.CMD_LINES ?? 1))
/** Body lines per fenced code block in the assistant answer. Answers in long
 *  sessions carry patch-sized fences; 6 is the historical fixture shape. */
const CODE_LINES = Math.max(1, Number(process.env.CODE_LINES ?? 6))

const [React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel }, { mountChannelUi }, { registerTuiChannel }, { bindChannelCommands }, { settled, sleep }] = await Promise.all([
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel-ui.js'),
  import('../src/adapter/channel/host-registry.js'),
  import('../src/dsh-adapter/channel/commands.js'),
  import('./lib/term-test.mjs'),
])

const { default: inkInstances } = await import('../src/ink/instances.js')
type ProbeNode = {
  nodeName?: string
  childNodes?: ProbeNode[]
  yogaNode?: { getComputedTop(): number; getComputedHeight(): number }
  scrollTop?: number
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  stickyScroll?: boolean
}
type RawEvent = { type: string; seq: number; time: number; data: Record<string, unknown> }

const events: RawEvent[] = []
let seq = 0
const append = (type: string, data: Record<string, unknown>): RawEvent => {
  seq += 1
  const event = { type, seq, time: seq, data }
  events.push(event)
  return event
}

const paraLine = (turn: number, line: number): string =>
  line % 5 === 0
    ? `- **要点 ${turn}/${line}**：解析输入、构建 AST、遍历节点做常量折叠，然后回写 source map；边界覆盖空输入与深层嵌套。`
    : `这是第 ${turn} 轮回答的第 ${line} 行正文，包含 \`code\` 与普通叙述文字，用来撑出真实长文本的行数与换行成本。`
const codeLine = (turn: number, line: number): string =>
  `const folded${turn}_${line} = visit(node, depth + ${line % 7}) // 保持缩进与注释`
/** A well-formed markdown document: balanced fences, so the fixture measures
 *  real wrap cost instead of an accidentally unterminated 100KB code block. */
const assistantText = (turn: number): string => {
  const lines: string[] = []
  const target = Math.max(12, Math.round((ASSISTANT_KB * 1024) / 62))
  let block = 0
  while (lines.length < target) {
    block += 1
    lines.push(paraLine(turn, block * 4 + 1), paraLine(turn, block * 4 + 2), paraLine(turn, block * 4 + 3))
    lines.push('```ts')
    for (let index = 0; index < CODE_LINES; index += 1) lines.push(codeLine(turn, block * 10 + index))
    lines.push('```')
    lines.push(paraLine(turn, block * 4 + 4))
  }
  return lines.join('\n')
}
const resultLine = (turn: number, line: number): string =>
  `  ${String(line).padStart(4, '0')} checking module ${turn} chunk … ok depth=${line % 37} tokens=${line * 17} sha=${(line * 2654435761 >>> 0).toString(16)}`
const commandText = (turn: number, call: number): string =>
  CMD_LINES === 1
    ? `node --check mod${turn}-${call}.js && node --test`
    : [
        "bash -lc 'set -euo pipefail",
        ...Array.from({ length: CMD_LINES - 1 }, (_, index) => `  echo step ${index + 1} of module ${turn}`),
        "'",
      ].join('\n')
/** One call's share of the round's result bytes (CALLS splits, never repeats). */
const resultText = (turn: number, call: number): string => {
  const lines = Math.max(4, Math.round((RESULT_KB * 1024) / CALLS / resultLine(turn, 1).length))
  return Array.from({ length: lines }, (_, index) => resultLine(turn, call * 100_000 + index + 1)).join('\n')
}

let humanTurns = 0
for (let turn = 1; turn <= ROUNDS; turn += 1) {
  const injected = turn % 75 === 0
  append('user/message', {
    id: injected ? `goal-${turn}` : `human-${turn}`,
    source: injected ? { kind: 'plugin', plugin: 'rail-perf' } : { kind: 'user' },
    content: [{ type: 'text', text: injected ? `GOAL-CONTINUE-${turn}` : `PROMPT-${turn} 请继续实现第 ${turn} 号模块的解析器。` }],
  })
  if (!injected) humanTurns += 1
  for (let call = 0; call < CALLS; call += 1) {
    const callId = `call-${turn}-${call}`
    append('tool/call', { turn, step: 1, callId, name: 'Bash', arguments: JSON.stringify({ command: commandText(turn, call) }) })
    append('tool/result', { turn, step: 1, callId, message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: resultText(turn, call) }] } })
  }
  append('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: assistantText(turn) }] } })
}

const callbacks = new Map<string, Set<(...args: unknown[]) => unknown>>()
const effectCleanups: (() => void)[] = []
let creates = 0
const createAgent = (id: string, record: RawEvent[]) => ({
  id, status: 'idle',
  session: { id: `${id}-session`, seq: record.at(-1)?.seq ?? 0, events: record, header: { cwd: scratch } },
  ctx: { on: () => () => undefined },
  followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true },
})
const agent = createAgent('rail-perf', events)
const services: Record<string, unknown> = {
  settings: { describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: {}, value: {} }, { ns: 'dsh-tui', revision: 1, user: {}, value: { recapOnOpen: false } }], get: () => ({}), mutate: async () => undefined },
  credentials: { resolve: async () => undefined, set: async () => undefined, unset: async () => undefined },
  llm: { listConfigurableProviders: () => [], discoverModels: async () => [] },
  agents: {
    create: async () => ({ agent: createAgent(`new-rail-${++creates}`, []), dispose: async () => undefined }),
    resume: async () => ({ agent: createAgent('resume-rail', []), dispose: async () => undefined }),
  },
}
const ctx = {
  on(name: string, listener: (...args: unknown[]) => unknown) {
    const listeners = callbacks.get(name) ?? new Set()
    listeners.add(listener)
    callbacks.set(name, listeners)
    return () => { listeners.delete(listener) }
  },
  effect(setup: () => () => void) { effectCleanups.push(setup()) },
  get(name: string) { return services[name] },
  logger: { warn() {} },
}
const raw = createChannel(ctx as never, agent as never, {
  model: 'model', provider: 'provider', cwd: scratch, activity: false,
  whale: false, whaleIdle: false, minimalUi: true, smoothStreaming: false,
})
const unregister = registerTuiChannel(ctx, raw)
const mount = mountChannelUi(ctx, raw, undefined, 'new')
let revealSyncMs = 0
// A rail click either materializes the clicked chunk (`revealRow` returns the
// revealed row id) or is a no-op because that chunk is already in `rows`.
// Recording the returns lets each sample prove it measured a real unloaded
// click instead of inferring it from a digest count that a fold-window
// repaint can also move.
const revealReturns: number[] = []
const measuredChannel = new Proxy(mount.channel, {
  get(target, property) {
    const value = Reflect.get(target, property, target)
    if (property !== 'revealRow' || typeof value !== 'function') return value
    return (rowId: number) => {
      const startedAt = performance.now()
      try {
        const out = value(rowId)
        revealReturns.push(out)
        return out
      } finally { revealSyncMs += performance.now() - startedAt }
    }
  },
})
bindChannelCommands(raw, mount.channel)

const COLS = 100
const ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) {
    term.write(String(chunk), () => done())
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdout = new FakeStdout()
const stdin = new FakeStdin()
const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
const screenLines = (): string[] => {
  const buffer = term.buffer.active
  return Array.from({ length: ROWS }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')
}
const railTicks = (): number[] => {
  const buffer = term.buffer.active
  const ticks: number[] = []
  for (let row = 0; row < ROWS; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)
    const glyphs = (line?.getCell(COLS - 2)?.getChars() ?? '') + (line?.getCell(COLS - 1)?.getChars() ?? '')
    if ((glyphs === '━━' || glyphs === '──' || glyphs === ' ─') && !line?.translateToString(true).includes('回到底部')) ticks.push(row)
  }
  return ticks
}
const activeTickRow = (): number => {
  const buffer = term.buffer.active
  for (const row of railTicks()) {
    const line = buffer.getLine(buffer.baseY + row)
    if (line?.getCell(COLS - 2)?.getChars() === '━' && line?.getCell(COLS - 1)?.getChars() === '━') return row
  }
  return -1
}
const scrollNode = (): ProbeNode | undefined => {
  const ink = inkInstances.get(stdout as never) as unknown as { rootNode?: ProbeNode } | undefined
  const walk = (node: ProbeNode): ProbeNode | undefined => {
    if (node.scrollViewportHeight !== undefined) return node
    for (const child of node.childNodes ?? []) {
      const found = walk(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  return ink?.rootNode === undefined ? undefined : walk(ink.rootNode)
}
const summaries = () => mount.channel.rows.filter(row => row.collapsed === true)
const allTurnCount = () => mount.channel.rows.flatMap(row => row.collapsedTurns ?? []).length +
  mount.channel.rows.filter(row => row.kind === 'user' && row.label !== 'team-message').length

const rowCharCount = (row: { kind: string; text?: string; tool?: { argsText?: string; resultText?: string }; collapsedTurns?: readonly unknown[] }): number => {
  const tool = row.tool
  const own = (row.text ?? '').length + (tool?.argsText?.length ?? 0) + (tool?.resultText?.length ?? 0)
  return own
}

const frameLog: Array<{ at: number; durationMs: number; commitMs: number | null; yogaMs: number | null; yogaVisited: number | null; yogaMeasured: number | null }> = []
let app: Awaited<ReturnType<typeof render>> | undefined
type Sample = {
  prompt: string
  clickedRow: number
  tickCount: number
  attempts: number
  rowsBefore: number
  summariesBefore: number
  revealSyncMs: number
  clickToMaterializeMs: number | null
  clickToLandedMs: number | null
  frames: number
  firstFrameMs: number
  lastFrameMs: number
  frameMs: number
  yogaMs: number | null
  yogaMeasured: number | null
  windows: Array<{ start: number; end: number; total: number; sticky: boolean }>
  landedExact: boolean
  /** Durable seq of the landed prompt row (null when the row carries none). */
  revealedSeq: number | null
  /** True when that seq was still inside a collapsed digest before the press:
   *  the reveal materialized an UNLOADED turn instead of re-showing a loaded one. */
  unloadedBefore: boolean
  /** Row kind of the landed row; the reveal must resolve to a human prompt. */
  revealedKind: string | null
}
const samples: Sample[] = []
let clickStartedAt: number | null = null
let traceOffset = 0
const firstLine = (text: string): string => text.split('\n').find(line => line.trim() !== '') ?? ''
const promptAt = (rowId: number): string => {
  const rows = mount.channel.rows
  const at = rows.findIndex(row => row.id === rowId)
  for (let index = Math.max(0, at); index < rows.length; index += 1) {
    const row = rows[index]!
    if (row.kind === 'user' && row.label !== 'team-message') return firstLine(row.text ?? '')
    if (index > at + 400) break
  }
  return ''
}
const runClick = async (label: string): Promise<void> => {
  // Pick a visible tick whose chunk is still folded. After earlier samples the
  // rail window moves, so a fixed row can point at an already-loaded turn; a
  // click on one reveals nothing and cannot be timed.
  let clickRow = -1
  let revealBefore = revealReturns.length
  let revealBeforeSync = revealSyncMs
  let frameStart = frameLog.length
  let rowsBefore = mount.channel.rows.length
  let attempts = 0
  let startedAt = 0
  let revealedRow = 0
  let before = summaries()
  for (let attempt = 0; attempt < 4 && revealedRow === 0; attempt += 1) {
    clickStartedAt = null
    before = summaries()
    const ticks = railTicks()
    assert.ok(ticks.length >= 3, 'rail must show a window of ticks')
    clickRow = ticks[Math.min(1 + attempt, ticks.length - 1)]!
    revealBefore = revealReturns.length
    // Capture every baseline before dispatch: reveal and frame callbacks can
    // run synchronously during the write rather than after this await.
    rowsBefore = mount.channel.rows.length
    revealBeforeSync = revealSyncMs
    frameStart = frameLog.length
    attempts = attempt + 1
    startedAt = performance.now()
    clickStartedAt = startedAt
    stdin.write(`\x1b[<0;${COLS};${clickRow + 1}M`)
    stdin.write(`\x1b[<0;${COLS};${clickRow + 1}m`)
    await settled(() => revealReturns.length > revealBefore, { stepMs: 1, timeoutMs: 1_500 })
    revealedRow = revealReturns.length > revealBefore ? (revealReturns.at(-1) ?? 0) : 0
  }
  assert.notEqual(revealedRow, 0, `${label}: click must reveal an unloaded chunk`)
  const byId = new Map(before.map(row => [row.id, firstLine(row.collapsedTurns?.[0]?.text ?? '')]))
  // Keyed on the clicked row, not on the collapsed-row count: the channel keeps
  // a bounded window of projected chunks, so revealing one can fold an older
  // one back in the same commit and leave the count unchanged.
  const materialized = await settled(
    () => mount.channel.rows.some(row => row.id === revealedRow),
    { stepMs: 1, timeoutMs: 60_000 },
  )
  const materializedAt = performance.now()
  const revealedRowState = mount.channel.rows.find(row => row.id === revealedRow)
  const revealedSeq = revealedRowState?.seq ?? null
  const revealedKind = revealedRowState?.kind ?? null
  // Identity, not just "a row appeared": revealRow returns the projected prompt
  // id, so its durable seq must have been sitting inside a collapsed digest in
  // the PRE-press snapshot. That is what proves this click materialized an
  // unloaded turn rather than re-revealing one that was already projected.
  const unloadedBefore = revealedSeq !== null && before.some(row =>
    (row.collapsedTurns ?? []).some(turn => turn.seq === revealedSeq))
  assert.equal(revealedKind, 'user', `${label}: reveal must resolve to the human prompt row`)
  assert.ok(unloadedBefore, `${label}: revealed seq ${String(revealedSeq)} must come from a digest folded before the press`)
  const needle = byId.get(revealedRow) ?? promptAt(revealedRow)
  assert.ok(needle.startsWith('PROMPT-'), `clicked turn must be a human prompt, got "${needle}"`)
  // Exact landing: the clicked turn's prompt owns the viewport top, not just
  // somewhere on screen. The sticky header may sit above it (row 0).
  const exact = (): boolean => screenLines().slice(0, 5).some(line => line.includes(needle))
  const landed = await settled(exact, { stepMs: 1, timeoutMs: 60_000 })
  const landedAt = performance.now()
  // 固定窗:探针 — after the first exact paint, a late seek release must not move it.
  await sleep(200)
  const stayed = exact()
  if (process.env.SCREEN === '1') {
    const added = mount.channel.rows.slice(rowsBefore)
    const kinds: Record<string, { rows: number; chars: number }> = {}
    for (const row of added) {
      const bucket = (kinds[row.kind] ??= { rows: 0, chars: 0 })
      bucket.rows += 1
      bucket.chars += rowCharCount(row)
    }
    console.error(`SCREEN ${label} rows+${added.length} ${JSON.stringify(kinds)}`)
    console.error(screenLines().map((line, at) => `S${String(at).padStart(2)}|${line}`).join('\n'))
  }
  clickStartedAt = null
  const frames = frameLog.slice(frameStart)
  const traceText = readFileSync(tracePath, 'utf8')
  const traceLines = traceText.slice(traceOffset).split('\n').filter(Boolean)
  traceOffset = traceText.length
  const windows = traceLines.flatMap(line => {
    try {
      const parsed = JSON.parse(line) as { list?: { start: number; end: number; total: number; sticky: boolean } | null }
      return parsed.list === undefined || parsed.list === null ? [] : [parsed.list]
    } catch { return [] }
  })
  samples.push({
    prompt: needle, clickedRow: clickRow, tickCount: railTicks().length, attempts, rowsBefore,
    summariesBefore: before.length, revealSyncMs: revealSyncMs - revealBeforeSync,
    clickToMaterializeMs: materialized ? materializedAt - startedAt : null,
    clickToLandedMs: landed ? landedAt - startedAt : null,
    frames: frames.length,
    // onFrame already recorded offsets relative to clickStartedAt.
    firstFrameMs: frames[0]?.at ?? -1,
    lastFrameMs: frames.at(-1)?.at ?? -1,
    frameMs: frames.reduce((total, frame) => total + frame.durationMs, 0),
    yogaMs: frames.length > 0 && frames.every(frame => frame.yogaMs !== null)
      ? frames.reduce((total, frame) => total + (frame.yogaMs ?? 0), 0) : null,
    yogaMeasured: frames.length > 0 && frames.every(frame => frame.yogaMeasured !== null)
      ? frames.reduce((total, frame) => total + (frame.yogaMeasured ?? 0), 0) : null,
    windows, landedExact: landed && stayed, revealedSeq, unloadedBefore, revealedKind,
  })
  if (!landed || !stayed) {
    const node = scrollNode()
    console.error(`LANDING-FAIL ${label} landed=${landed} needle=${JSON.stringify(needle)} top=${node?.scrollTop} height=${node?.scrollHeight} viewport=${node?.scrollViewportHeight} sticky=${node?.stickyScroll} clickRow=${clickRow}`)
    console.error(screenLines().map((line, row) => `${String(row).padStart(2)}|${line}`).join('\n'))
    console.error(`FRAMES ${JSON.stringify(frames)}`)
  }
  // DIAG=1 downgrades the landing assert to a report so a long click series can
  // still exercise the crash path (repeated navigation, many reveals) while the
  // landing precision is being investigated separately.
  if (process.env.DIAG === '1') return
  assert.ok(landed && stayed, `${label}: click must land exactly on the clicked turn`)
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
}
try {
  app = await render(
    <AlternateScreen><Chat channel={measuredChannel} questionStore={new QuestionStore()} fullscreen trajectorySeen onExit={() => {
      process.exitCode = 1
      console.error('RAIL_CLICK_EXIT unexpected Chat exit')
    }} /></AlternateScreen>,
    {
      stdout: stdout as never, stdin: stdin as never, stderr: stderr as never,
      patchConsole: false, exitOnCtrlC: false,
      onFrame: frame => {
        if (clickStartedAt !== null) {
          frameLog.push({
            at: performance.now() - clickStartedAt,
            durationMs: frame.durationMs,
            // Missing instrumentation is unknown, not a zero-cost phase.
            commitMs: frame.phases?.commit ?? null,
            yogaMs: frame.phases?.yoga ?? null,
            yogaVisited: frame.phases?.yogaVisited ?? null,
            yogaMeasured: frame.phases?.yogaMeasured ?? null,
          })
        }
      },
    },
  )
  const ready = await settled(() => railTicks().length > 2 && allTurnCount() > 0, { stepMs: 5, timeoutMs: 120_000 })
  assert.ok(ready, 'session must paint with a rail')
  const bootSummaries = summaries().length
  console.log(`FIXTURE rounds=${ROUNDS} chunks=${bootSummaries + 1} humanTurns=${humanTurns} rows=${mount.channel.rows.length} assistantKB=${ASSISTANT_KB} resultKB=${RESULT_KB} cmdLines=${CMD_LINES} codeLines=${CODE_LINES}`)
  assert.ok(bootSummaries + 1 >= 124, `fixture must have 124+ chunks, got ${bootSummaries + 1}`)
  let failedRequest: { label: string; recorded: boolean; message: string } | undefined
  for (let index = 0; index < CLICKS; index += 1) {
    const label = `click-${index + 1}`
    const beforeCount = samples.length
    try {
      await runClick(label)
    } catch (error) {
      clickStartedAt = null
      failedRequest = { label, recorded: samples.length > beforeCount, message: error instanceof Error ? error.message : String(error) }
      console.error(`RAIL_CLICK_ABORT ${label}:`, error)
      break
    }
  }
  console.log(`RAIL_CLICK_FRAMES ${JSON.stringify(frameLog.slice(0, 40))}`)
  const materialize = samples.map(sample => sample.clickToMaterializeMs).filter((value): value is number => value !== null)
  const landed = samples.map(sample => sample.clickToLandedMs).filter((value): value is number => value !== null)
  console.log(`RAIL_CLICK_SAMPLES ${JSON.stringify(samples.map(sample => ({
    prompt: sample.prompt,
    attempts: sample.attempts,
    rowsBefore: sample.rowsBefore,
    summariesBefore: sample.summariesBefore,
    revealSyncMs: Math.round(sample.revealSyncMs * 100) / 100,
    clickToMaterializeMs: sample.clickToMaterializeMs === null ? null : Math.round(sample.clickToMaterializeMs),
    clickToLandedMs: sample.clickToLandedMs === null ? null : Math.round(sample.clickToLandedMs),
    frames: sample.frames,
    firstFrameMs: Math.round(sample.firstFrameMs),
    lastFrameMs: Math.round(sample.lastFrameMs),
    frameMs: Math.round(sample.frameMs),
    yogaMs: sample.yogaMs === null ? null : Math.round(sample.yogaMs),
    yogaMeasured: sample.yogaMeasured,
    biggestWindow: sample.windows.reduce((max, window) => Math.max(max, window.end - window.start), 0),
    landedExact: sample.landedExact,
    revealedSeq: sample.revealedSeq,
    unloadedBefore: sample.unloadedBefore,
  })))}`)
  const diagnosticPercentile = (values: number[], p: number): number | null =>
    values.length === 0 ? null : Math.round(percentile(values, p))
  // An acceptance percentile is published only when every sample proved, on
  // this run's own data: the reveal resolved to a human prompt row (kind), that
  // prompt's durable seq sat inside a digest folded BEFORE the press (so the
  // click really materialized an unloaded turn), the row reached the viewport
  // top and stayed there for the recheck window, and no request went
  // unrecorded. Still not machine-checked here: that the screen row this probe
  // pressed maps to that turn's tick — that is the rail's own hit-test, covered
  // by scripts/verify-timeline-rail.tsx; and the landing is asserted through
  // text by the prompt's unique `PROMPT-<n>` prefix rather than a Yoga offset.
  const verified = failedRequest === undefined
    && samples.length === CLICKS
    && materialize.length === samples.length
    && landed.length === samples.length
    && samples.every(sample => sample.landedExact && sample.unloadedBefore && sample.revealedKind === 'user')
  console.log(`RAIL_CLICK_SUMMARY ${JSON.stringify({
    status: verified ? 'verified' : 'exploratory-unverified',
    conditionalPercentilesOnly: !verified,
    requested: CLICKS,
    clicks: samples.length,
    failedRequest: failedRequest ?? null,
    unrecordedRequests: Math.max(0, CLICKS - samples.length),
    attemptsTotal: failedRequest !== undefined && !failedRequest.recorded
      ? null : samples.reduce((total, sample) => total + sample.attempts, 0),
    landed: landed.length,
    landedExact: samples.filter(sample => sample.landedExact).length,
    materializeNotObserved: samples.length - materialize.length,
    landingNotObserved: samples.length - landed.length,
    landingUnstableOrInexact: samples.filter(sample => sample.clickToLandedMs !== null && !sample.landedExact).length,
    retriedSamples: samples.filter(sample => sample.attempts > 1).length,
    identityOk: samples.filter(sample => sample.unloadedBefore && sample.revealedKind === 'user').length,
    materializeP50: verified ? diagnosticPercentile(materialize, 50) : null,
    materializeP95: verified ? diagnosticPercentile(materialize, 95) : null,
    landedP50: verified ? diagnosticPercentile(landed, 50) : null,
    landedP95: verified ? diagnosticPercentile(landed, 95) : null,
    exploratoryMaterializeP50: diagnosticPercentile(materialize, 50),
    exploratoryMaterializeP95: diagnosticPercentile(materialize, 95),
    exploratoryLandedP50: diagnosticPercentile(landed, 50),
    exploratoryLandedP95: diagnosticPercentile(landed, 95),
  })}`)
  if (!verified) {
    console.error('UNVERIFIED: identity/exact-landing/recording invariants failed; p95 is diagnostic only')
    process.exitCode = 1
  }
  if (process.env.VERBOSE === '1') {
    for (const sample of samples) {
      console.error(`WINDOWS ${sample.prompt} ${JSON.stringify(sample.windows)}`)
    }
  }
  if (process.env.DIAG !== '1') assert.equal(samples.filter(sample => sample.landedExact).length, samples.length, 'every click must land exactly')
} finally {
  let teardownFailed = false
  const failure = (part: string, error: unknown): void => {
    teardownFailed = true
    process.exitCode = 1
    console.error(`TEARDOWN ${part}:`, error)
  }
  try { await app?.unmount() } catch (error) { failure('app', error) }
  try { unregister() } catch (error) { failure('registration', error) }
  for (const cleanup of effectCleanups) {
    try { cleanup() } catch (error) { failure('effect', error) }
  }
  try { term.dispose() } catch (error) { failure('terminal', error) }
  // Keep files if teardown may have left an active writer, or when requested.
  // Path validation and recursive removal are not atomic against replacement.
  if (process.env.KEEP === '1' || teardownFailed) {
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
