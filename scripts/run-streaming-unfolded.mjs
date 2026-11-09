/**
 * Run the streaming regression without shell fd syntax or GNU timeout/nice.
 *
 *   node scripts/run-streaming-unfolded.mjs
 *
 * Child fd 1 is drained and discarded: the renderer may write terminal reset
 * bytes there during teardown. The regression's independent fd 3 is forwarded
 * to our stdout, and child stderr is forwarded to stderr. The child has no real
 * HOME/DSH/XDG settings or credentials in its environment. Its own script
 * creates and checks its private temporary directory before application imports.
 *
 * The wrapper uses Node rather than shell fd syntax, but the extra fd and
 * terminal behavior have not yet been verified on Windows.
 * A normal child exit is propagated unchanged; a timeout is reported as 124.
 */
import { spawn } from 'node:child_process'
import { constants as osConstants, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const test = join(root, 'scripts', 'verify-streaming-unfolded.tsx')
// Deliberately nonexistent: the child creates its own checked temp root.
// This avoids exposing the caller's real home even to the tsx loader.
const unavailableHome = join(tmpdir(), `dsh-stream-loader-nohome-${randomUUID()}`)
const env = {
  PATH: process.env.PATH ?? '',
  NODE_ENV: 'production',
  HOME: unavailableHome,
  USERPROFILE: unavailableHome,
  TMPDIR: tmpdir(),
  TMP: tmpdir(),
  TEMP: tmpdir(),
  XDG_CONFIG_HOME: join(unavailableHome, 'config'),
  XDG_CACHE_HOME: join(unavailableHome, 'cache'),
  XDG_DATA_HOME: join(unavailableHome, 'data'),
  XDG_STATE_HOME: join(unavailableHome, 'state'),
  DSH_HOME: join(unavailableHome, 'dsh'),
  TSX_DISABLE_CACHE: '1',
}
// Windows process creation and Node tooling can need these OS paths. None is a
// user session or credential; no other inherited variables reach the loader.
for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
  if (process.env[key] !== undefined) env[key] = process.env[key]
}

const child = spawn(process.execPath, ['--import', 'tsx/esm', test], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
child.stdout.resume()
child.stderr.pipe(process.stderr, { end: false })
child.stdio[3].pipe(process.stdout, { end: false })

const timeoutMs = 90_000
let timedOut = false
let externalSignal = null
let forceTimer
let spawnError = null
function terminate() {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  if (!forceTimer) {
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5_000)
  }
}
const timeout = setTimeout(() => {
  timedOut = true
  process.stderr.write(`streaming-unfolded: timed out after ${timeoutMs}ms; terminating child\n`)
  terminate()
}, timeoutMs)
const onSignal = signal => {
  externalSignal ??= signal
  terminate()
}
const onInt = () => onSignal('SIGINT')
const onTerm = () => onSignal('SIGTERM')
process.on('SIGINT', onInt)
process.on('SIGTERM', onTerm)
child.on('error', error => { spawnError = error })
// close, not exit: the fd 3 reporter has also drained before returning.
child.on('close', (code, signal) => {
  clearTimeout(timeout)
  if (forceTimer) clearTimeout(forceTimer)
  process.off('SIGINT', onInt)
  process.off('SIGTERM', onTerm)
  if (spawnError) {
    process.stderr.write(`streaming-unfolded: child spawn error: ${spawnError.message}\n`)
    process.exitCode = 1
  } else if (timedOut) {
    process.exitCode = 124
  } else if (externalSignal) {
    process.exitCode = 128 + (osConstants.signals[externalSignal] ?? 1)
  } else if (code !== null) {
    process.exitCode = code
  } else {
    process.exitCode = 128 + (osConstants.signals[signal] ?? 1)
  }
})
