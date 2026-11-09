/**
 * Frame statistics for long-session stress diagnosis.
 *
 * `DSH_TUI_FRAME_STATS=1` makes the TUI print one line to stderr every ~2 s
 * summarising the frames it just painted plus the process's memory: frame
 * count, worst frame duration, the split between render / diff / terminal
 * write, painted patch count, the Yoga work per frame, how many transcript
 * rows were MOUNTED (see MessageList's window), and heap + RSS. Harness
 * measurements ("click to landed") say what a single gesture costs; this says
 * whether the TUI stays healthy when a reader clicks rail tick after rail
 * tick — the reported "flicking through the Titan session a few times kills
 * the process" needs a scheme that shows growth over MINUTES, not one number.
 *
 * Off by default (one boolean per frame when disabled, nothing else).
 */
import type { FrameEvent } from '../ink/frame.js'

const ENABLED = process.env.DSH_TUI_FRAME_STATS === '1'
const INTERVAL_MS = Math.max(500, Number(process.env.DSH_TUI_FRAME_STATS_MS ?? 2000))
/** Largest single frame in the window, with its phase split. */
type Window = {
  from: number
  frames: number
  dur: number
  maxDur: number
  maxRender: number
  maxDiff: number
  maxOptimize: number
  maxWriteMs: number
  maxPatches: number
  maxYoga: number
  maxYogaVisited: number
  maxYogaMeasured: number
  maxCommit: number
  /** Transcript rows in the mount window at the worst frame (MessageList). */
  rowWindow: number
  rowsTotal: number
}
let windowStart = Date.now()
let stats: Window = {
  from: windowStart,
  frames: 0,
  dur: 0,
  maxDur: 0,
  maxRender: 0,
  maxDiff: 0,
  maxOptimize: 0,
  maxWriteMs: 0,
  maxPatches: 0,
  maxYoga: 0,
  maxYogaVisited: 0,
  maxYogaMeasured: 0,
  maxCommit: 0,
  rowWindow: 0,
  rowsTotal: 0,
}

/** MessageList's latest mount window, reported once per frame (cheap: two
 *  numbers, no geometry). Kept here so the frame stat and the window that
 *  produced it land on the same line. */
let rowWindow = 0
let rowsTotal = 0
export function noteRowWindow(mounted: number, total: number): void {
  if (!ENABLED) return
  rowWindow = mounted
  rowsTotal = total
}

export function frameStatsEnabled(): boolean {
  return ENABLED
}

export function noteFrameStats(event: FrameEvent): void {
  if (!ENABLED) return
  const phases = event.phases ?? {
    renderer: 0, diff: 0, optimize: 0, write: 0, patches: 0, yoga: 0,
    commit: 0, yogaVisited: 0, yogaMeasured: 0, yogaCacheHits: 0, yogaLive: 0,
  }
  stats.frames += 1
  stats.dur += event.durationMs
  if (event.durationMs > stats.maxDur) {
    stats.maxDur = event.durationMs
    stats.maxRender = phases.renderer
    stats.maxDiff = phases.diff
    stats.maxOptimize = phases.optimize
    stats.maxWriteMs = phases.write
    stats.maxPatches = phases.patches
    stats.maxYoga = phases.yoga
    stats.maxYogaVisited = phases.yogaVisited ?? 0
    stats.maxYogaMeasured = phases.yogaMeasured ?? 0
    stats.maxCommit = phases.commit
    stats.rowWindow = rowWindow
    stats.rowsTotal = rowsTotal
  }
  const now = Date.now()
  if (now - windowStart < INTERVAL_MS) return
  const mem = process.memoryUsage()
  const elapsed = now - stats.from
  const line = {
    at: new Date(now).toISOString(),
    windowMs: elapsed,
    frames: stats.frames,
    fps: Number((stats.frames / (elapsed / 1000)).toFixed(1)),
    avgMs: stats.frames === 0 ? 0 : Number((stats.dur / stats.frames).toFixed(1)),
    worstMs: Number(stats.maxDur.toFixed(1)),
    worstRenderMs: Number(stats.maxRender.toFixed(1)),
    worstDiffMs: Number(stats.maxDiff.toFixed(1)),
    worstOptimizeMs: Number(stats.maxOptimize.toFixed(1)),
    worstWriteMs: Number(stats.maxWriteMs.toFixed(1)),
    worstPatches: stats.maxPatches,
    worstYogaMs: Number(stats.maxYoga.toFixed(1)),
    worstYogaVisited: stats.maxYogaVisited,
    worstYogaMeasured: stats.maxYogaMeasured,
    worstCommitMs: Number(stats.maxCommit.toFixed(1)),
    yogaLive: phases.yogaLive,
    rowWindow: stats.rowWindow,
    rowsTotal: stats.rowsTotal,
    heapUsedMB: Math.round(mem.heapUsed / 1048576),
    externalMB: Math.round(mem.external / 1048576),
    rssMB: Math.round(mem.rss / 1048576),
  }
  process.stderr.write(`DSH_FRAME_STATS ${JSON.stringify(line)}\n`)
  windowStart = now
  stats = {
    from: now,
    frames: 0,
    dur: 0,
    maxDur: 0,
    maxRender: 0,
    maxDiff: 0,
    maxOptimize: 0,
    maxWriteMs: 0,
    maxPatches: 0,
    maxYoga: 0,
    maxYogaVisited: 0,
    maxYogaMeasured: 0,
    maxCommit: 0,
    rowWindow,
    rowsTotal,
  }
}
