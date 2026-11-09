#!/usr/bin/env node
/**
 * Isolated launcher for verify-scroll-anchor-overscroll.tsx.
 * Run: node scripts/verify-scroll-anchor-overscroll.mjs
 * Non-Linux platforms have not been validated.
 */
import { spawn } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let scratch
async function main() {
  const tempRoot = realpathSync(tmpdir())
  scratch = realpathSync(mkdtempSync(join(tempRoot, 'dsh-scroll-anchor-overscroll-')))
  if (dirname(scratch) !== tempRoot || !basename(scratch).startsWith('dsh-scroll-anchor-overscroll-')) throw new Error('unexpected scratch location')
  if (process.platform !== 'win32') chmodSync(scratch, 0o700)
  const owned = lstatSync(scratch)
  for (const name of ['config', 'cache', 'data', 'state', 'runtime', 'dsh', 'appdata', 'localappdata']) mkdirSync(join(scratch, name), { mode: 0o700 })
  const tracePath = join(scratch, 'trace.json')
  // Never inherit credentials or user config. Windows needs a small OS env
  // whitelist; all home/config/temp paths are explicitly redirected.
  const env = {
    NODE_ENV: 'production', FORCE_COLOR: '3', TERM: 'xterm-256color', LANG: 'C.UTF-8',
    HOME: scratch, USERPROFILE: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    XDG_CONFIG_HOME: join(scratch, 'config'), XDG_CACHE_HOME: join(scratch, 'cache'),
    XDG_DATA_HOME: join(scratch, 'data'), XDG_STATE_HOME: join(scratch, 'state'), XDG_RUNTIME_DIR: join(scratch, 'runtime'),
    XDG_CONFIG_DIRS: join(scratch, 'config'), XDG_DATA_DIRS: join(scratch, 'data'),
    DSH_HOME: join(scratch, 'dsh'), APPDATA: join(scratch, 'appdata'), LOCALAPPDATA: join(scratch, 'localappdata'),
    DSH_OVERSCROLL_SCRATCH: scratch, DSH_OVERSCROLL_TEMP_ROOT: tempRoot, RESULT_TRACE: tracePath,
  }
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'PATH']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
  }
  if (process.platform !== 'linux') console.error(`NOTE: platform ${process.platform} has not been validated`)
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'scripts/verify-scroll-anchor-overscroll.tsx'], {
    cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let exited = false, closed = false, error = null, reason = null, interrupted = null
  let escalation = null, drain = null, drainTimedOut = false
  const attempts = []
  const live = () => !exited && !closed && child.exitCode === null && child.signalCode === null && Boolean(child.pid)
  const send = signal => {
    if (!live()) return
    try { attempts.push({ signal, sent: child.kill(signal) }) }
    catch (err) { attempts.push({ signal, sent: false, error: String(err) }) }
  }
  const stop = why => {
    if (!live()) return
    reason ??= why
    if (escalation !== null) return
    send('SIGTERM')
    escalation = setTimeout(() => send('SIGKILL'), 2000)
  }
  const onSigint = () => { interrupted ??= 'SIGINT'; stop('parent-SIGINT') }
  const onSigterm = () => { interrupted ??= 'SIGTERM'; stop('parent-SIGTERM') }
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  const timer = setTimeout(() => stop('timeout'), 90000)
  const limit = 1024 * 1024
  const streams = {
    stdout: { chunks: [], observed: 0, stored: 0, overflow: false },
    stderr: { chunks: [], observed: 0, stored: 0, overflow: false },
  }
  for (const key of ['stdout', 'stderr']) {
    child[key].on('data', chunk => {
      const s = streams[key]
      s.observed += chunk.length
      const remaining = limit - s.stored
      if (remaining > 0) { const kept = chunk.subarray(0, remaining); s.chunks.push(kept); s.stored += kept.length }
      if (s.observed > limit && !s.overflow) { s.overflow = true; stop(`${key}-overflow`) }
    })
    child[key].on('error', err => { error ??= `${key}: ${String(err)}`; stop(`${key}-error`) })
  }
  child.on('error', err => { error ??= String(err) })
  child.on('exit', () => {
    exited = true
    clearTimeout(timer)
    if (escalation !== null) clearTimeout(escalation)
    // Never signal after leader exit. Do not guess who might hold a pipe.
    drain = setTimeout(() => { drainTimedOut = true; child.stdout.destroy(); child.stderr.destroy() }, 2000)
  })
  const outcome = await new Promise(resolve => child.on('close', (status, signal) => resolve({ status, signal })))
  closed = true
  clearTimeout(timer)
  if (escalation !== null) clearTimeout(escalation)
  if (drain !== null) clearTimeout(drain)
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  const stdout = Buffer.concat(streams.stdout.chunks), stderr = Buffer.concat(streams.stderr.chunks)
  writeFileSync(join(scratch, 'stdout.log'), stdout)
  writeFileSync(join(scratch, 'stderr.log'), stderr)
  let trace = null, traceError = null
  try { trace = JSON.parse(readFileSync(tracePath, 'utf8')) }
  catch (err) { traceError = String(err) }
  const names = ['bottom-noop', 'up-control', 'seek-then-down']
  const traceComplete = trace?.code === 0 && trace?.dropped === 0 && Array.isArray(trace?.reports) &&
    names.every(name => trace.reports.some(r => r.name === name && !r.error))
  const result = { ...outcome, error, reason, interrupted, exitObserved: exited, closeObserved: true, drainTimedOut,
    attempts, traceError, traceComplete, output: Object.fromEntries(Object.entries(streams).map(([k, s]) => [k,
      { observed: s.observed, stored: s.stored, overflow: s.overflow }])) }
  writeFileSync(join(scratch, 'summary.json'), JSON.stringify(result, null, 2))
  if (stdout.length) process.stdout.write(stdout)
  if (stderr.length) process.stderr.write(stderr)
  const ok = outcome.status === 0 && !outcome.signal && !error && !reason && !interrupted && !drainTimedOut &&
    !streams.stdout.overflow && !streams.stderr.overflow && traceComplete
  if (!ok) {
    console.error(`scroll-anchor-overscroll failed/incomplete; retained scratch: ${scratch}`)
    process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1
    return
  }
  // Remove only the exact real directory created by this process, only after
  // successful child close and complete evidence. Never follow a replaced root.
  const current = lstatSync(scratch)
  if (!current.isDirectory() || current.isSymbolicLink() || realpathSync(scratch) !== scratch ||
      realpathSync(tempRoot) !== tempRoot || dirname(scratch) !== tempRoot ||
      !basename(scratch).startsWith('dsh-scroll-anchor-overscroll-') || current.dev !== owned.dev || current.ino !== owned.ino) {
    throw new Error(`refusing cleanup of changed scratch: ${scratch}`)
  }
  rmSync(scratch, { recursive: true })
  console.log('scroll-anchor-overscroll passed; private scratch removed')
}
main().catch(error => {
  console.error(`scroll-anchor-overscroll launcher error: ${String(error)}${scratch ? `; retained scratch: ${scratch}` : ''}`)
  process.exitCode = 1
})
