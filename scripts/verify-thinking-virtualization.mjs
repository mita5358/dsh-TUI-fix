// Run: node scripts/verify-thinking-virtualization.mjs --run
// Production child with synthetic scratch and an allowlisted environment.
// Windows and non-Linux runtime behavior has not been verified.
import { spawn } from 'node:child_process'
import { lstatSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.argv.length !== 3 || process.argv[2] !== '--run') throw new Error('Usage: node scripts/verify-thinking-virtualization.mjs --run')
const repoRoot = new URL('../', import.meta.url)
const probe = fileURLToPath(new URL('scripts/thinking-virtualization-probe.mjs', repoRoot))
const require = createRequire(new URL('package.json', repoRoot))
const loader = require.resolve('tsx/esm')
const tempRoot = realpathSync(tmpdir())
const prefix = 'dsh-thinking-virtual-'
const scratch = mkdtempSync(join(tempRoot, prefix))
const original = lstatSync(scratch)
const verifyScratch = () => {
  const current = lstatSync(scratch)
  if (dirname(scratch) !== tempRoot || !basename(scratch).startsWith(prefix) ||
      realpathSync(dirname(scratch)) !== tempRoot || realpathSync(scratch) !== scratch ||
      !current.isDirectory() || current.dev !== original.dev || current.ino !== original.ino) {
    throw new Error('refusing to use or clean a replaced scratch directory')
  }
  if (process.platform !== 'win32' && (typeof process.getuid !== 'function' ||
      current.uid !== process.getuid() || (current.mode & 0o077) !== 0)) {
    throw new Error('scratch directory must be private and owned by the current user')
  }
}
verifyScratch()
for (const dir of ['home', 'dsh', 'config', 'cache', 'data', 'state', 'runtime', 'tmp']) mkdirSync(join(scratch, dir))
const env = {
  NODE_ENV: 'production', HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'), DSH_HOME: join(scratch, 'dsh'),
  XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
  XDG_DATA_HOME: join(scratch, 'data'), XDG_STATE_HOME: join(scratch, 'state'), XDG_RUNTIME_DIR: join(scratch, 'runtime'),
  XDG_CONFIG_DIRS: join(scratch, 'config'), XDG_DATA_DIRS: join(scratch, 'data'),
  TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'),
  DSH_TUI_GEOMETRY_TRACE: join(scratch, 'geometry.jsonl'),
  DSH_TUI_THEME: 'dark', DSH_TUI_LANG: 'en', FORCE_COLOR: '3',
  DSH_THINK_SCRATCH: scratch, DSH_THINK_TEMP_ROOT: tempRoot,
  PATH: process.platform === 'win32' ? '' : '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'xterm-256color',
}
if (process.platform === 'win32') {
  // Windows process startup may require these, but no other inherited user
  // environment (including credentials) is forwarded to the child.
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
}
const TIMEOUT_MS = 45_000, GRACE_MS = 2_000, LIMIT = 200_000
let stopCurrent = null, interrupted = null
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted ??= signal; stopCurrent?.(`parent-${signal}`) })
const result = await new Promise(resolve => {
  const child = spawn(process.execPath, ['--import', loader, probe], {
    cwd: scratch, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const streams = Object.fromEntries(['stdout', 'stderr'].map(key => [key, { chunks: [], stored: 0, observed: 0, overflow: false }]))
  let error = null, reason = null, escalation = null, drainTimer = null
  let exitObserved = false, closed = false, drainTimedOut = false
  const signals = []
  const leaderRunning = () => !closed && !exitObserved && child.exitCode === null && child.signalCode === null && Boolean(child.pid)
  const killGroup = signal => {
    if (!leaderRunning()) return
    try {
      // POSIX detached child leads its own group. On Windows signal only the
      // still-live child we created; no process-tree guarantee is implied.
      const sent = process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal)
      signals.push({ signal, sent })
    } catch (err) { signals.push({ signal, sent: false, error: String(err) }) }
  }
  const stop = why => {
    if (!leaderRunning()) return
    reason ??= why
    if (escalation !== null) return
    killGroup('SIGTERM')
    escalation = setTimeout(() => killGroup('SIGKILL'), GRACE_MS)
  }
  stopCurrent = stop
  const timeout = setTimeout(() => stop('timeout'), TIMEOUT_MS)
  for (const key of ['stdout', 'stderr']) {
    child[key].on('data', chunk => {
      const state = streams[key]
      state.observed += chunk.length
      const remaining = LIMIT - state.stored
      if (remaining > 0) { const kept = chunk.subarray(0, remaining); state.chunks.push(kept); state.stored += kept.length }
      if (state.observed > LIMIT && !state.overflow) { state.overflow = true; stop(`${key}-output-limit`) }
    })
    child[key].on('error', err => { error ??= `${key}: ${String(err)}`; stop(`${key}-pipe-error`) })
  }
  child.on('error', err => { error ??= String(err) })
  child.on('exit', () => {
    exitObserved = true
    clearTimeout(timeout)
    if (escalation !== null) clearTimeout(escalation)
    // Never signal a process group after its leader exits. An inherited pipe
    // held open by an unknown process is a failure, not grounds to guess PID.
    drainTimer = setTimeout(() => { drainTimedOut = true; child.stdout.destroy(); child.stderr.destroy() }, GRACE_MS)
  })
  child.on('close', (code, signal) => {
    closed = true
    clearTimeout(timeout)
    if (escalation !== null) clearTimeout(escalation)
    if (drainTimer !== null) clearTimeout(drainTimer)
    stopCurrent = null
    resolve({ code, signal, error, reason, exitObserved, closeObserved: true, drainTimedOut, signals, streams })
  })
  if (interrupted) stop(`parent-${interrupted}`)
})
for (const key of ['stdout', 'stderr']) process.stdout.write(Buffer.concat(result.streams[key].chunks))
const output = Object.fromEntries(Object.entries(result.streams).map(([key, state]) => [key, { observed: state.observed, stored: state.stored, overflow: state.overflow }]))
let failed = result.code !== 0 || Boolean(result.error || result.reason || result.drainTimedOut || interrupted) || Object.values(output).some(s => s.overflow)
let cleanupError = null, scratchRetained = true
if (!failed && result.closeObserved) {
  try {
    // Never clean up after a pipe-drain timeout or any other failed run.
    // Recheck the original owned directory immediately before removal.
    verifyScratch()
    rmSync(scratch, { recursive: true })
    scratchRetained = false
  } catch (err) { cleanupError = String(err); failed = true }
}
console.log(`SUPERVISOR ${JSON.stringify({ code: result.code, signal: result.signal, error: result.error, reason: result.reason, exitObserved: result.exitObserved, closeObserved: result.closeObserved, drainTimedOut: result.drainTimedOut, signals: result.signals, output, interrupted, scratch, scratchRetained, cleanupError })}`)
if (failed) process.exitCode = 1
