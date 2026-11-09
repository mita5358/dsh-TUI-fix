/**
 * Real event -> channel -> Chat/MessageList -> terminal stream regression.
 * No real session, credential, profile or terminal is used.
 * Run serially: nice -n 10 node --import tsx/esm scripts/verify-long-prose-ansi.tsx
 */
import assert from 'node:assert/strict'
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

const tmpBase = realpathSync(tmpdir())
const scratch = mkdtempSync(join(tmpBase, 'dsh-long-prose-ansi-'))
const scratchReal = realpathSync(scratch)
const envBefore = { ...process.env }
// No inherited application paths, secrets or user configuration reach imports.
for (const key of Object.keys(process.env)) {
  if (/^(DSH|XDG|HOME|.*(?:TOKEN|SECRET|CREDENTIAL|API_KEY|PASSWORD))/i.test(key)) delete process.env[key]
}
process.env.HOME = join(scratch, 'home')
process.env.DSH_HOME = join(scratch, 'dsh')
process.env.XDG_CONFIG_HOME = join(scratch, 'config')
process.env.XDG_CACHE_HOME = join(scratch, 'cache')
process.env.XDG_DATA_HOME = join(scratch, 'data')
process.env.XDG_STATE_HOME = join(scratch, 'state')
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'en'
process.env.TERM = 'xterm-256color'
process.env.TERM_PROGRAM = 'kitty' // Explicitly exercise OSC8 rather than the URL-only fallback.
mkdirSync(process.env.HOME, { recursive: true })

const [React, { Terminal }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel }, { mountChannelUi }, { registerTuiChannel }, { bindChannelCommands }, { settled }, { marked }, { formatToken, configureMarked }] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'), import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'), import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel-ui.js'), import('../src/adapter/channel/host-registry.js'),
  import('../src/dsh-adapter/channel/commands.js'), import('./lib/term-test.mjs'),
  import('marked'), import('../src/terminal-utils/markdown.js'),
])

const COLS = 100
const ROWS = 55
const short = '[go](https://example.com) ' + '**x** '.repeat(145)
configureMarked()
const formatted = marked.lexer(short).map(token => formatToken(token, 0, null, null, null)).join('')
assert.ok(short.length < 1000 && formatted.length > 1000, `fixture lengths ${short.length}/${formatted.length}`)
console.log(`fixture: raw=${short.length}, markdown ANSI=${formatted.length}`)

// Parse the *concatenated* terminal stream, never individual writes/frames.
// The renderer legitimately splits cursor/SGR restoration across writes.
function validateStream(stream: string): void {
  let state: 'ground' | 'esc' | 'csi' | 'osc' | 'oscEsc' = 'ground'
  let osc = ''
  let linkOpen = false
  const finishOsc = () => {
    if (!osc.startsWith('8;')) return
    assert.match(osc, /^8;[^;]*;[^\x00-\x1f]*$/)
    linkOpen = osc.slice(osc.indexOf(';', 2) + 1) !== ''
  }
  for (let i = 0; i < stream.length; i++) {
    const c = stream[i]!
    const n = c.charCodeAt(0)
    if (state === 'ground') { if (c === '\x1b') state = 'esc'; continue }
    if (state === 'esc') {
      if (c === '[') state = 'csi'
      else if (c === ']') { state = 'osc'; osc = '' }
      else if (n >= 0x30 && n <= 0x7e) state = 'ground'
      else throw new Error(`invalid ESC at byte ${i}`)
    } else if (state === 'csi') {
      if (n >= 0x40 && n <= 0x7e) state = 'ground'
      else if (n < 0x20 || n > 0x3f) throw new Error(`incomplete CSI before byte ${i}`)
    } else if (state === 'osc') {
      if (c === '\x07') { finishOsc(); state = 'ground' }
      else if (c === '\x1b') state = 'oscEsc'
      else if (n < 0x20) throw new Error(`incomplete OSC before byte ${i}`)
      else osc += c
    } else {
      if (c !== '\\') throw new Error(`incomplete OSC/ST before byte ${i}`)
      finishOsc()
      state = 'ground'
    }
  }
  assert.equal(state, 'ground', `terminal stream ends inside ${state}`)
  assert.equal(linkOpen, false, 'OSC8 hyperlink left open at end of terminal stream')
}
// A restore can cross writes; an unfinished or interrupted control sequence
// cannot. Self-check the validator against both without inventing frame cuts.
validateStream(['\x1b[38;2;', '1;2;3m', '\x1b]8;;https://example.com', '\x07x', '\x1b]8;;\x07', '\x1b[0', 'm'].join(''))
assert.throws(() => validateStream('\x1b[38;2;1'))
assert.throws(() => validateStream('\x1b]8;;https://example.com\x1b[0m'))

const longUrl = 'https://example.com/' + 'u'.repeat(1100) + 'URLTAIL'
const longLabel = 'L'.repeat(1100) + 'LABELTAIL'
const longBold = 'B'.repeat(1100) + 'BOLDTAIL'
const issue = 'owner/repo#123456789'
const issueTarget = 'https://github.com/owner/repo/issues/123456789'
const filePath = './src/file.ts-backup'
const fileTarget = 'dsh-file:' + encodeURIComponent(filePath)
// Put the truncation boundary inside the meaningful token, not in padding.
const boundaryPrefix = (partial: string) => 'p'.repeat(999 - partial.length) + ' '
// Both BEL and ST terminate OSC; parameters (including optional ids) vary.
const osc8Hrefs = (stream: string): string[] =>
  [...stream.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map(match => match[1]!)
const cases = [
  { name: 'short formatted prose', source: short, kind: 'short' },
  { name: 'long Markdown URL', source: `[go](${longUrl})`, kind: 'url', target: longUrl, prefix: 'https://example.com/u', tail: 'go' },
  { name: 'bare long URL', source: longUrl, kind: 'bare-url', target: longUrl, prefix: 'https://example.com/u', tail: 'URLTAIL' },
  { name: 'issue reference boundary', source: boundaryPrefix('owner/repo#12') + issue, kind: 'issue', target: issueTarget, prefix: 'https://github.com/owner/repo/issues/', tail: issue },
  { name: 'file reference boundary', source: boundaryPrefix('./src/file.ts') + filePath, kind: 'file', target: fileTarget, prefix: 'dsh-file:', tail: filePath },
  { name: 'Markdown reference URL', source: `[go][ref]\n\n[ref]: ${longUrl}`, kind: 'reference', target: longUrl, prefix: 'https://example.com/u', tail: 'go' },
  { name: 'long label', source: `[${longLabel}](https://example.com)`, kind: 'label', tail: 'LABELTAIL' },
  { name: 'long bold', source: `**${longBold}**`, kind: 'bold', tail: 'BOLDTAIL' },
] as const
let failures = 0
try {
  for (const item of cases) {
    const events = [
      { type: 'user/message', seq: 1, time: 1, data: { id: 'prompt', source: { kind: 'user' }, content: [{ type: 'text', text: 'TEST PROMPT' }] } },
      { type: 'assistant/message', seq: 2, time: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: item.source + '\n\nAFTER_SENTINEL' }] } } },
    ]
    const callbacks = new Map<string, Set<(...args: unknown[]) => unknown>>()
    const cleanups: (() => void)[] = []
    const agent = { id: 'isolated', status: 'idle', session: { id: 'isolated-session', seq: 2, events, header: { cwd: scratch } }, ctx: { on: () => () => undefined }, followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true } }
    const services: Record<string, unknown> = {
      settings: { describe: () => [{ ns: 'dsh-tui', revision: 1, user: {}, value: { recapOnOpen: false } }], get: () => ({}), mutate: async () => undefined },
      credentials: { resolve: async () => undefined, set: async () => { throw new Error('credential write forbidden') }, unset: async () => { throw new Error('credential write forbidden') } },
      llm: { listConfigurableProviders: () => [], discoverModels: async () => [] },
    }
    const ctx = { on(name: string, listener: (...args: unknown[]) => unknown) { const set = callbacks.get(name) ?? new Set(); set.add(listener); callbacks.set(name, set); return () => { set.delete(listener) } }, effect(setup: () => () => void) { cleanups.push(setup()) }, get(name: string) { return services[name] }, logger: { warn() {} } }
    const raw = createChannel(ctx as never, agent as never, { model: 'model', provider: 'provider', cwd: scratch, activity: false, whale: false, whaleIdle: false, minimalUi: true, smoothStreaming: false })
    const unregister = registerTuiChannel(ctx, raw)
    const mount = mountChannelUi(ctx, raw, undefined, 'new')
    bindChannelCommands(raw, mount.channel)
    const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
    // Ink writes shutdown restoration directly to stdout.fd. Capture those
    // synchronous writes AND stream writes in the same owned file, preserving
    // their actual ordering; neither ever targets the user's fd 1.
    const capturePath = join(scratch, `terminal-${item.kind}`)
    const fd = openSync(capturePath, 'wx+')
    let output = ''
    let pending = 0
    class FakeOut extends Writable {
      columns = COLS; rows = ROWS; isTTY = true; fd = fd
      _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) { writeSync(fd, chunk); output += chunk.toString(); pending++; term.write(chunk.toString(), () => { pending--; done() }) }
    }
    class FakeIn extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
    const stdout = new FakeOut()
    const stdin = new FakeIn()
    const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: false, fd })
    const lines = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '')
    const text = () => lines().join('\n')
    const message = () => {
      const screen = lines()
      const begin = screen.findIndex(line => line.includes('● '))
      const end = screen.findIndex((line, index) => index > begin && line.includes('AFTER_SENTINEL'))
      assert.ok(begin >= 0 && end > begin, 'assistant and trailing sentinel must be visible')
      return screen.slice(begin, end).join('\n')
    }
    const assertSentinelNotBold = () => {
      const sentinelRow = lines().findIndex(line => line.includes('AFTER_SENTINEL'))
      assert.ok(sentinelRow >= 0, 'following paragraph must remain visible')
      const sentinelCol = lines()[sentinelRow]!.indexOf('AFTER_SENTINEL')
      assert.equal(Boolean(term.buffer.active.getLine(term.buffer.active.baseY + sentinelRow)?.getCell(sentinelCol)?.isBold()), false, 'bold must not leak into the following paragraph')
    }
    let app: Awaited<ReturnType<typeof render>> | undefined
    try {
      assert.ok(mount.channel.rows.some(row => row.kind === 'assistant' && row.text.includes(item.source)), 'real event must project into assistant row')
      app = await render(<AlternateScreen><Chat channel={mount.channel} questionStore={new QuestionStore()} fullscreen trajectorySeen /></AlternateScreen>, { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, patchConsole: false, exitOnCtrlC: false })
      assert.ok(await settled(() => pending === 0 && text().includes('AFTER_SENTINEL')), 'initial terminal paint did not settle')
      assertSentinelNotBold()
      if (item.kind === 'short') {
        assert.doesNotMatch(text(), /chars folded/i, 'short raw prose must not be folded due to ANSI expansion')
        assert.ok(message().includes('go'), 'link label must remain visible')
        assert.ok(osc8Hrefs(output).includes('https://example.com'), 'actual output must preserve the hyperlink destination')
        assert.equal((message().match(/x/g) ?? []).length, 145, 'every formatted x must be painted')
        let boldX = 0
        const screen = lines()
        const begin = screen.findIndex(line => line.includes('● '))
        const end = screen.findIndex((line, index) => index > begin && line.includes('AFTER_SENTINEL'))
        assert.ok(begin >= 0 && end > begin, 'assistant text must be bounded on screen')
        for (let y = begin; y < end; y++) for (let x = 0; x < COLS; x++) {
          const cell = term.buffer.active.getLine(term.buffer.active.baseY + y)?.getCell(x)
          if (cell?.getChars() === 'x' && cell.isBold()) boldX++
        }
        assert.equal(boldX, 145, 'all x cells must actually be bold in xterm')
      } else {
        assert.match(text(), /chars folded/i, 'long input must offer expansion')
        if ('target' in item) {
          // The capture is the real sequence of terminal writes, not the
          // formatted model. A complete href or no href is safe; a clipped
          // or otherwise changed destination is not.
          const hrefs = osc8Hrefs(output)
          const wrong = hrefs.filter(href => href.startsWith(item.prefix) && href !== item.target)
          if (wrong.length) {
            failures++
            console.error(`FAIL: ${item.name} folded paint emits wrong OSC8 href(s): ${JSON.stringify(wrong.map(href => href.slice(0, 100)))} lengths=${wrong.map(href => href.length).join(',')}`)
          } else console.log(`PASS: ${item.name} folded paint has no incorrect target`)
        }
        const before = output.length
        stdin.write('\x0f') // actual Chat key event, not a model toggle
        assert.ok(await settled(() => pending === 0 && output.length > before && !/chars folded/i.test(text()) && text().replace(/\s/g, '').includes(item.tail)), 'Ctrl+O must reveal preserved content')
        if ('target' in item) assert.ok(output.slice(before).includes(item.target), 'expanded real terminal output must contain the complete hyperlink target')
        if (item.kind === 'label') assert.equal((message().match(/L/g) ?? []).length, (longLabel.match(/L/g) ?? []).length, 'the complete expanded label must be visible')
        if (item.kind === 'bold') assert.equal((message().match(/B/g) ?? []).length, (longBold.match(/B/g) ?? []).length, 'the complete expanded bold content must be visible')
        assertSentinelNotBold()
      }
      console.log(`PASS: ${item.name}${item.kind === 'short' ? '' : ' expansion'}`)
    } catch (error) {
      failures++
      console.error(`FAIL: ${item.name}:`, error, '\nSCREEN:\n' + text())
    } finally {
      if (app) await app.unmount()
      // unmount may leave stream writes queued even though its own cleanup is
      // synchronous. End/finish waits for every _write/xterm callback before
      // inspecting the stream, disposing the terminal or closing its fd.
      await new Promise<void>((resolve, reject) => {
        stdout.once('error', reject)
        stdout.end(() => resolve())
      })
      assert.equal(pending, 0, 'xterm output must drain before closing its fd')
      try { validateStream(readFileSync(capturePath, 'utf8')) } catch (error) { failures++; console.error(`FAIL: ${item.name} terminal stream:`, error) }
      mount.dispose(); unregister(); raw.releaseContributions(); for (const cleanup of cleanups.reverse()) cleanup()
      term.dispose(); closeSync(fd)
    }
  }
} finally {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, envBefore)
  const actual = realpathSync(scratch)
  assert.equal(actual, scratchReal, 'temporary directory identity changed')
  assert.equal(dirname(actual), tmpBase, 'temporary directory escaped its parent')
  assert.ok(basename(actual).startsWith('dsh-long-prose-ansi-'), 'refuse to delete non-test directory')
  assert.equal(resolve(scratch), actual, 'temporary path must not traverse symlinks')
  rmSync(actual, { recursive: true })
}
if (failures) process.exitCode = 1
else console.log('Long prose ANSI regression passed')
