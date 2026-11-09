/*
 * Settled subagent cards must not traverse their unused call history.
 * Run: node --import tsx/esm scripts/verify-subagent-settled-no-scan.mjs
 * React is loaded dynamically after the production environment is set.
 * Real production component and Chat; no loader hooks and no forced redraw.
 * The pre-fix code must fail the settled element-access assertion. Proxy counts
 * are not timing measurements. A private scratch directory survives any error.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, lstatSync, fstatSync, readdirSync, rmSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

// No React or application module has been imported yet.
process.env.NODE_ENV = 'production'
const windows = process.platform === 'win32'
if (!windows && (typeof process.getuid !== 'function' || typeof process.getgid !== 'function')) throw new Error('POSIX uid/gid required')
// Only select the existing temporary parent, then create a distinct scratch
// with mkdtemp. Its origin may be an inherited OS temp setting; we do not read
// any other children. Windows ACL privacy of that parent is NOT established.
const tmp = realpathSync(tmpdir())
const scratch = mkdtempSync(join(tmp, 'verify-subagent-no-scan-'))
const rootIdentity = lstatSync(scratch)
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino && (windows || (a.uid === b.uid && a.gid === b.gid))
if (!rootIdentity.isDirectory() || (!windows && (rootIdentity.uid !== process.getuid() || rootIdentity.gid !== process.getgid() || (rootIdentity.mode & 0o777) !== 0o700))) throw new Error(`unsafe scratch retained: ${scratch}`)
// Clear inherited app settings and credentials before application imports.
// Keep only platform startup essentials and PATH; no user profile is retained.
const retainedEnv = Object.fromEntries(['PATH', ...(windows ? ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'] : [])].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, retainedEnv, {
  NODE_ENV: 'production', TZ: 'UTC', TERM: 'xterm-256color', HOME: scratch, USERPROFILE: scratch,
  DSH_HOME: join(scratch, 'dsh'), XDG_CONFIG_HOME: join(scratch, 'config'),
  XDG_CACHE_HOME: join(scratch, 'cache'), XDG_DATA_HOME: join(scratch, 'data'),
  XDG_STATE_HOME: join(scratch, 'state'), XDG_RUNTIME_DIR: join(scratch, 'runtime'),
  XDG_CONFIG_DIRS: join(scratch, 'config'), XDG_DATA_DIRS: join(scratch, 'data'),
  TMPDIR: scratch, TMP: scratch, TEMP: scratch, DSH_TUI_LANG: 'en', FORCE_COLOR: '0',
})
// Watchdog is a failure deadline, not an assertion window. No forced redraw.
const watchdog = setTimeout(() => {
  console.error(`TIMEOUT: scratch retained at ${scratch}`)
  process.exit(1)
}, 60000)

// Validate the root and every descendant before removing a private tree. No
// symlink, special file, owner mismatch, replaced root, or unexpected parent.
// A concurrent process running as the same uid is outside this private-dir
// isolation model; all writes in this test are synchronous or awaited.
function verifyTree(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || stat.uid !== rootIdentity.uid || stat.gid !== rootIdentity.gid) throw new Error(`unsafe scratch member: ${path}`)
  if (stat.isDirectory()) for (const name of readdirSync(path)) verifyTree(join(path, name))
  else if (!stat.isFile()) throw new Error(`unexpected scratch member: ${path}`)
}
function removeVerifiedScratch() {
  let now = lstatSync(scratch)
  if (dirname(scratch) !== tmp || realpathSync(scratch) !== scratch || !sameIdentity(now, rootIdentity) || !now.isDirectory() || (now.mode & 0o777) !== 0o700) throw new Error('scratch root changed; retained')
  verifyTree(scratch)
  now = lstatSync(scratch)
  if (!sameIdentity(now, rootIdentity) || (now.mode & 0o777) !== 0o700) throw new Error('scratch root changed during inspection; retained')
  rmSync(scratch, { recursive: true })
}

const COLS = 120, ROWS = 40
class Input extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
function sample(status) {
  const calls = Array.from({ length: 1000 }, (_, i) => ({ id: `tool-${i}`, name: `tool${i}`, status: 'ok', startedAt: 1 }))
  calls[9] = { id: 'first-prev', name: 'FirstPredecessor', status: 'ok', startedAt: 1 }
  const duplicate = { id: 'dup', name: 'RunningProbe', status: 'running', startedAt: 1 }
  calls[10] = duplicate
  calls[999] = duplicate
  const reads = { iterator: 0, index: 0 }
  const toolCalls = new Proxy(calls, { get(target, key, receiver) {
    if (key === Symbol.iterator) reads.iterator++
    if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) reads.index++
    return Reflect.get(target, key, receiver)
  } })
  const startedAt = Date.now() - 2000
  return { reads, sub: { agentId: 'child-probe', runId: 'run-probe', description: 'SUBAGENT-PROBE', provider: 'dsh', model: 'probe', status,
    startedAt, completedAt: status === 'running' ? undefined : startedAt + 1000, durationMs: 1000,
    outputLines: ['live one', 'live two', 'live three'], output: [], outputEvents: [], summary: 'DETAIL-SUMMARY-PROBE', toolCalls,
    tokens: { total: 12 }, ...(status === 'failed' ? { error: 'ERROR-PROBE' } : {}) } }
}

let succeeded = false
try {
  // Imports are deliberately relative to scripts/, not to this draft's /tmp.
  const [React, { Terminal }, { render, AlternateScreen, useInput }, { SubagentMessage }, { Chat }, { QuestionStore }, { settled }] = await Promise.all([
    import('react'), import('@xterm/headless'), import('../src/ui.js'), import('../src/components/Chat/SubagentMessage.js'),
    import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'), import('./lib/term-test.mjs'),
  ])
  const labels = { completed: ['🟢', 'completed'], failed: ['🔴', 'failed'], cancelled: ['🔴', 'Cancelled'], unknown: ['⚪', 'status unknown'] }
  async function exercise(status, surface) {
    const { sub, reads } = sample(status)
    const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
    const fd = openSync(join(scratch, `${surface}-${status}.reset`), 'wx', 0o600)
    const fdIdentity = fstatSync(fd)
    let pendingWrites = 0, frames = 0, clicked = false, app
    class Output extends Writable {
      isTTY = true; columns = COLS; rows = ROWS; fd = fd
      _write(chunk, _encoding, done) { pendingWrites++; term.write(String(chunk), () => { pendingWrites--; done() }) }
    }
    class ErrorSink extends Writable { isTTY = true; _write(_chunk, _encoding, done) { done() } }
    const stdin = new Input(), stdout = new Output(), stderr = new ErrorSink()
    const screen = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '')
    const listeners = new Set()
    const channel = { version: 0, rows: [{ id: 1, kind: 'subagent', text: sub.description, subagent: sub }], subagents: [sub],
      agentId: 'synthetic-parent', sessionId: 'synthetic-session', status: 'idle', working: false, whale: false, whaleIdle: false,
      model: 'probe', provider: 'probe', reasoningEffort: 'high', tokens: { input: 0, output: 0 }, cwd: scratch, displayCwd: scratch,
      gitBranch: 'main', spinnerMode: 'responding', responseChars: 0, activeToolCount: 0, turnStart: 0,
      pending: [], notifications: [], commandList: [], mode: { plan: false },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, submit() {}, cancel() {}, clear() {}, notify() {}, loadOlder() {}, setResumeTarget() {},
      listModels: async () => [], listSessions: async () => [], mcpStatus: () => [] }
    function ComponentHarness() { useInput(() => {}); return React.createElement(SubagentMessage, { subagent: sub, marginTopOnTurn: false, isExpanded: false, onClick: () => { clicked = true } }) }
    const tree = surface === 'component' ? React.createElement(ComponentHarness) : React.createElement(Chat, { channel, questionStore: new QuestionStore(), fullscreen: true, trajectorySeen: true })
    try {
      assert.ok(fdIdentity.isFile() && (windows || (fdIdentity.uid === rootIdentity.uid && fdIdentity.gid === rootIdentity.gid && (fdIdentity.mode & 0o777) === 0o600)), 'unsafe reset fd')
      app = await render(React.createElement(AlternateScreen, null, tree), { stdout, stdin, stderr, patchConsole: false, exitOnCtrlC: false, onFrame: () => { frames++ } })
      assert.ok(await settled(() => frames > 0 && pendingWrites === 0 && screen().some(line => line.includes('SUBAGENT-PROBE'))), `${surface}/${status}: painted frame`)
      const lines = screen(), y = lines.findIndex(line => line.includes('SUBAGENT-PROBE'))
      assert.ok(stdin.listenerCount('readable') > 0, `${surface}/${status}: input parser not attached`)
      assert.ok(lines[y].includes('1000 tools'), `${surface}/${status}: count missing: ${lines[y]}`)
      if (status !== 'running') {
        const [glyph, label] = labels[status]
        const expected = `  ${glyph} Subagent: SUBAGENT-PROBE · probe · 1s · 12 tok · 1000 tools · ${label}`
        assert.equal(lines[y].trimEnd(), expected + (surface === 'chat' ? '  ⤢' : ''), `${surface}/${status}: settled card changed`)
        if (status === 'failed') assert.ok(lines[y + 1].includes('ERROR-PROBE'), `${surface}: failed error hidden`)
        assert.deepEqual(reads, { iterator: 0, index: 0 }, `${surface}/${status}: settled card accessed elements`)
      } else {
        const visible = lines.join('\n')
        assert.ok(visible.includes('FirstPredecessor') && visible.includes('RunningProbe'), `${surface}: duplicate-call prior tool semantics changed`)
        assert.ok(visible.includes('live one') && visible.includes('live three'), `${surface}: live waterfall changed`)
        // Do not require any specific traversal implementation for running.
      }
      const line = term.buffer.active.getLine(term.buffer.active.baseY + y), marker = 'SUBAGENT-PROBE'
      let x = -1
      for (let col = 0; col <= COLS - marker.length; col++) {
        let text = ''
        for (let i = 0; i < marker.length; i++) text += line?.getCell(col + i)?.getChars() ?? ''
        if (text === marker) { x = col; break }
      }
      assert.ok(x >= 0, `${surface}/${status}: marker cell missing`)
      stdin.write(`\x1b[<0;${x + 1};${y + 1}M`)
      stdin.write(`\x1b[<0;${x + 1};${y + 1}m`)
      assert.ok(await settled(() => surface === 'component' ? clicked : pendingWrites === 0 && screen().some(line => line.includes('DETAIL-SUMMARY-PROBE')) && screen().some(line => line.includes('1000 tools'))), `${surface}/${status}: click/detail`)
      console.log(`PASS ${surface}/${status}`)
    } finally {
      try { if (app !== undefined) await app.unmount() } finally {
        term.dispose()
        const beforeClose = fstatSync(fd)
        closeSync(fd)
        assert.ok(beforeClose.isFile() && sameIdentity(fdIdentity, beforeClose) && (windows || (beforeClose.mode & 0o777) === 0o600), 'reset fd changed identity/mode; scratch retained')
      }
    }
  }
  for (const status of ['completed', 'failed', 'cancelled', 'unknown', 'running']) {
    for (const surface of ['component', 'chat']) await exercise(status, surface)
  }
  succeeded = true
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  if (succeeded && !windows) {
    try { removeVerifiedScratch() } catch (error) { console.error(error); process.exitCode = 1 }
  }
  if (windows || !succeeded || process.exitCode) {
    console.error(`scratch retained: ${scratch}${windows ? ' (Windows ACL not verified; retained even on success)' : ''}`)
  }
}
