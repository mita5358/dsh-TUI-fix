/** Real Chat/xterm fixture with a private synthetic channel and home.
 * Used by verify-settled-thinking-chat.mjs; no real backend or transcript.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { lstatSync, mkdtempSync, openSync, closeSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

// React chooses its production/dev build at first load; reject a misconfigured
// process before importing React, xterm, or any application module.
assert.equal(process.env.NODE_ENV, 'production', 'NODE_ENV=production is required before React loads')

// Remove inherited credentials and user settings before importing the app.
const allowedEnv = new Set(['NODE_ENV', 'PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'])
for (const key of Object.keys(process.env)) if (!allowedEnv.has(key)) delete process.env[key]
const root = realpathSync(tmpdir())
const home = realpathSync(mkdtempSync(join(root, 'dsh-thinking-fixture-')))
const created = lstatSync(home)
let cleaned = false
export function cleanup() {
  if (cleaned) return
  const actual = realpathSync(home)
  const current = lstatSync(home)
  assert.equal(actual, home)
  assert.equal(dirname(actual), root)
  assert.ok(basename(actual).startsWith('dsh-thinking-fixture-'))
  assert.ok(current.isDirectory() && current.dev === created.dev && current.ino === created.ino)
  if (process.platform !== 'win32') {
    assert.equal(current.uid, process.getuid())
    assert.equal(current.mode & 0o077, 0)
  }
  rmSync(actual, { recursive: true })
  cleaned = true
}
process.once('exit', cleanup)
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, DSH_HOME: join(home, '.dsh'),
  XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
  XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
  DSH_TUI_LANG: 'en', DSH_TUI_THEME: 'dark', FORCE_COLOR: '3', TERM: 'xterm-256color',
})

const repo = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(join(repo, 'package.json'))
const React = require('react')
const { Terminal } = require('@xterm/headless')
const appImport = path => import(pathToFileURL(join(repo, path)).href)
const [{ render, AlternateScreen }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS }, { setLang }, { stringWidth }, { settled, sleep }] = await Promise.all([
  appImport('src/ui.ts'), appImport('src/screens/Chat.tsx'), appImport('src/dsh-adapter/questions.ts'),
  appImport('src/commands.ts'), appImport('src/i18n.ts'), appImport('src/ink/stringWidth.ts'), appImport('scripts/lib/term-test.mjs'),
])

export { setLang, sleep }
export async function rig({ columns = 100, rows = 45, initialRows = [], thinkingFold = 'preview' } = {}) {
  const term = new Terminal({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  const titleChanges = []
  term.onTitleChange(title => titleChanges.push(title))
  const fd = openSync(join(home, `tty-${Math.random().toString(36).slice(2)}`), 'w')
  let pendingWrites = 0, frames = 0, requiredFrame = -1
  // Hard cap applies to the whole rig lifetime, including redraws. Never
  // truncate silently: stop feeding the oversized chunk to xterm and fail at
  // the next drain. Retained output is at most OUTPUT_LIMIT UTF-16 code units.
  const OUTPUT_LIMIT = 256 * 1024
  let output = '', outputOverflow = false
  class Stdout extends Writable {
    isTTY = true
    constructor() { super(); this.columns = columns; this.rows = rows; this.fd = fd }
    _write(chunk, _encoding, done) {
      if (outputOverflow) { done(); return }
      // UTF-8 byte size upper-bounds decoded UTF-16 units for valid text;
      // rejecting first prevents even transient conversion of a giant chunk.
      const remaining = OUTPUT_LIMIT - output.length
      if (Buffer.isBuffer(chunk) && chunk.length > remaining * 3) { outputOverflow = true; done(); return }
      const text = String(chunk)
      if (text.length > remaining) { outputOverflow = true; done(); return }
      output += text
      pendingWrites++
      term.write(text, () => { pendingWrites--; done() })
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
  const listeners = new Set()
  const channel = {
    version: 0, rows: initialRows, thinkingFold, smoothStreaming: false,
    agentId: 'synthetic-agent', sessionId: 'synthetic-session', whaleIdle: false,
    status: 'idle', sessionTitle: 'fixture', model: 'model', provider: 'fixture',
    tokens: { input: 0, output: 0 }, cwd: home, displayCwd: home, gitBranch: '',
    working: false, spinnerMode: 'requesting', mode: { plan: false }, responseChars: 0,
    activeToolCount: 0, turnStart: 0, lastUserText: '', pending: [],
    commandList: LOCAL_COMMANDS, commandCompletions: () => [], notifications: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    submit() {}, steer() {}, cancel() {}, clear() { this.rows = []; this.emit() }, notify() {},
    listModels: async () => [], listSessions: () => [], setResumeTarget() {},
    emit() { requiredFrame = frames; this.version++; for (const fn of listeners) fn() },
  }
  const screen = () => {
    const buffer = term.buffer.active
    return Array.from({ length: rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
  }
  const drain = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve, reject) => stdout.write('', error => error ? reject(error) : resolve()))
      if (pendingWrites === 0 && stdout.writableLength === 0) {
        if (outputOverflow) throw new Error(`terminal output capture exceeded hard limit ${OUTPUT_LIMIT}; assertion invalid`)
        return
      }
    }
    throw new Error('xterm did not drain')
  }
  const wait = async (predicate, timeoutMs = 2500) => {
    const ok = await settled(() => frames > requiredFrame && pendingWrites === 0 && stdout.writableLength === 0 && predicate(), { timeoutMs })
    await drain()
    return Boolean(ok && predicate())
  }
  const setRows = newRows => { channel.rows = newRows; channel.emit() }
  const click = async (label, accepts = () => true) => {
    await drain()
    const line = screen().findIndex(text => text.includes(label) && accepts(text))
    if (line < 0) return false
    const text = screen()[line]
    const charOffset = text.indexOf(label)
    const col = stringWidth(text.slice(0, charOffset)) + 1
    requiredFrame = frames
    stdin.write(`\x1b[<0;${col};${line + 1}M\x1b[<0;${col};${line + 1}m`)
    return true
  }
  const input = text => { requiredFrame = frames; stdin.write(text) }
  let app
  try {
    app = await render(
      React.createElement(AlternateScreen, null, React.createElement(Chat, { channel, questionStore: new QuestionStore(), fullscreen: true, trajectorySeen: true })),
      { stdout, stdin, stderr, patchConsole: false, exitOnCtrlC: false, onFrame: () => { frames++ } },
    )
  } catch (error) {
    term.dispose()
    closeSync(fd)
    throw error
  }
  return {
    channel, term, screen, wait, setRows, click, input, drain, titleChanges,
    getOutput: () => output,
    async close() {
      try { await app.unmount(); await drain() }
      finally { term.dispose(); closeSync(fd) }
    },
  }
}
