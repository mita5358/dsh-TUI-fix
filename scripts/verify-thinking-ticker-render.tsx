/** Real Ink/xterm coverage for the live thinking ticker and spinner.
 * Run: node --import tsx/esm scripts/verify-thinking-ticker-render.tsx
 */
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'

process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'
const [React, { Terminal }, { render, Box, Text }, { AssistantThinkingMessage }, { settled }] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/components/messages/AssistantThinkingMessage.js'), import('./lib/term-test.mjs'),
])

const COLS = 70, ROWS = 12
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
let pending = 0
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  override _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) {
    pending++
    term.write(String(chunk), () => { pending--; done() })
  }
}
const output = new FakeStdout()
const screen = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '')
const full = `${'unseen reasoning\n'.repeat(1000)}VISIBLE-FIRST\nVISIBLE-MIDDLE\nVISIBLE-LAST`
const updated = `${'old line\n'.repeat(4)}NEW-FIRST\n\n`
const originalSplit = String.prototype.split
let fullSplits = 0, updatedSplits = 0
String.prototype.split = function (...args: Parameters<typeof originalSplit>) {
  const value = String(this)
  if (value === full) fullSplits++
  if (value === updated) updatedSplits++
  return originalSplit.apply(this, args)
}
let app: Awaited<ReturnType<typeof render>> | undefined
try {
  app = await render(
    <Box flexDirection="column" width={COLS}>
      <AssistantThinkingMessage thinking="REVEALED-ONLY" textFull={full} marginTopOnTurn={false} verbose={false} streaming preview />
      <Text>AFTER-TICKER</Text>
    </Box>,
    { stdout: output as never, exitOnCtrlC: false, patchConsole: false },
  )
  const firstReady = await settled(() => pending === 0 && screen().some(line => line.includes('VISIBLE-LAST')) && screen().some(line => line.includes('AFTER-TICKER')), { timeoutMs: 5000 })
  assert.ok(firstReady, 'full arrived text and the following row must be painted')
  const lines = screen()
  const header = lines.findIndex(line => line.includes('Thinking'))
  assert.ok(header >= 0, 'streaming header must be visible')
  assert.ok(lines[header + 1]?.includes('…VISIBLE-FIRST'), 'first visible line must carry the clipping marker')
  assert.ok(lines[header + 2]?.includes('VISIBLE-MIDDLE'), 'second visible line must remain intact')
  assert.ok(lines[header + 3]?.includes('VISIBLE-LAST'), 'third visible line must follow arrived text')
  assert.ok(lines[header + 4]?.includes('AFTER-TICKER'), 'ticker height must remain three rows')
  assert.ok(!lines.some(line => line.includes('unseen reasoning') || line.includes('REVEALED-ONLY')), 'offscreen reasoning and the lagging revealed text must not replace the ticker')
  const firstHeader = lines[header]
  assert.ok(await settled(() => pending === 0 && screen()[header] !== firstHeader && screen()[header]!.includes('Thinking'), { timeoutMs: 5000 }), 'the real spinner must advance and repaint')
  assert.equal(fullSplits, 0, 'spinner must not split the entire arrived reasoning into lines')
  app.rerender(
    <Box flexDirection="column" width={COLS}>
      <AssistantThinkingMessage thinking="REVEALED-ONLY" textFull={updated} marginTopOnTurn={false} verbose={false} streaming preview />
      <Text>AFTER-TICKER</Text>
    </Box>,
  )
  assert.ok(await settled(() => pending === 0 && screen().some(line => line.includes('NEW-FIRST')) && !screen().some(line => line.includes('VISIBLE-LAST')), { timeoutMs: 5000 }), 'updated arrived text must repaint')
  const updatedLines = screen()
  const updatedHeader = updatedLines.findIndex(line => line.includes('Thinking'))
  assert.ok(updatedHeader >= 0 && updatedLines[updatedHeader + 1]?.includes('…NEW-FIRST'), 'updated first line must retain the clipping marker')
  assert.equal(updatedLines[updatedHeader + 2]?.trim(), '│', 'middle empty line must remain empty')
  assert.equal(updatedLines[updatedHeader + 3]?.trim(), '│', 'trailing newline must keep the final empty line')
  assert.ok(updatedLines[updatedHeader + 4]?.includes('AFTER-TICKER'), 'updated ticker must retain its fixed height')
  const updatedHeaderText = updatedLines[updatedHeader]
  assert.ok(await settled(() => pending === 0 && screen()[updatedHeader] !== updatedHeaderText && screen()[updatedHeader]!.includes('Thinking'), { timeoutMs: 5000 }), 'spinner must advance after the text update')
  assert.equal(updatedSplits, 0, 'updated arrived reasoning must not be split into a full line array')
  app.rerender(
    <Box flexDirection="column" width={COLS}>
      <AssistantThinkingMessage thinking="REVEALED-ONLY" textFull="" marginTopOnTurn={false} verbose={false} streaming preview />
      <Text>AFTER-TICKER</Text>
    </Box>,
  )
  const emptyReady = await settled(() => pending === 0 && !screen().some(line => line.includes('NEW-FIRST')) && screen().some(line => line.includes('AFTER-TICKER')), { timeoutMs: 5000 })
  if (!emptyReady) console.error(JSON.stringify({ pending, screen: screen() }))
  assert.ok(emptyReady, 'empty arrived text must repaint')
  assert.ok(!screen().some(line => line.includes('REVEALED-ONLY')), 'empty textFull must not fall back to revealed text')
  console.log('thinking ticker render: content, fixed height, spinner, empty textFull and bounded line array passed')
} finally {
  String.prototype.split = originalSplit
  await app?.unmount()
  term.dispose()
}
