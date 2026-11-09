/**
 * Folded fence summary equivalence and allocation regression.
 * Run: node --expose-gc --import tsx/esm scripts/verify-folded-code-summary.ts
 */
import assert from 'node:assert/strict'
import { summarizeFoldedCode } from '../src/components/Markdown.js'

function original(text: string): { lineCount: number; preview: string } {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const lineCount = text === '' ? 0 : lines.length
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return { lineCount, preview: trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed }
  }
  return { lineCount, preview: '' }
}

const fixtures = [
  '', '\n', '\n\n', 'a', 'a\n', 'a\n\n', '\r\n\r\n  x  \r\n',
  '\u00a0\ufeff\u2028\u2029\n\t字😀  \r\nsecond', '\u0085\nnext',
  '  ' + 'a'.repeat(159) + '  ', 'a'.repeat(160), 'a'.repeat(161),
  'a'.repeat(159) + '😀' + '  \n', ' '.repeat(100_000) + '\n  tail  ',
  ('x\n').repeat(200_000), '  ' + 'x'.repeat(1_000_000) + '  ',
  'x' + ' '.repeat(1_000_000) + '\nnext',
  ' '.repeat(4095) + '😀' + '\u2028\u2029\nnext',
  '😀' + ' '.repeat(4095) + '\nsecond',
  '\u2028'.repeat(4096) + '\u2029\r\n' + 'first' + '\nlast',
  'x'.repeat(4095) + '😀' + ' '.repeat(4095),
]
for (const text of fixtures) assert.deepEqual(summarizeFoldedCode(text), original(text))

// Check the trim classification of every UTF-16 code unit, not just examples.
for (let code = 0; code <= 0xffff; code++) {
  const unit = String.fromCharCode(code)
  for (const text of [unit + 'x', 'x' + unit, unit + '\n' + 'x']) {
    assert.deepEqual(summarizeFoldedCode(text), original(text), `UTF-16 unit ${code.toString(16)}`)
  }
}

// Deterministic differential fuzz includes lone surrogates and every trim whitespace.
let seed = 0x12345678
const units = ['a', ' ', '\n', '\r', '\t', '\v', '\f', '\u00a0', '\u1680', '\u2000', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff', '\u0085', '\ud83d', '\ude00', '中']
for (let trial = 0; trial < 10_000; trial++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  const length = seed % 300
  let text = ''
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    text += units[seed % units.length]
  }
  assert.deepEqual(summarizeFoldedCode(text), original(text), `trial ${trial}`)
}

assert.ok(global.gc, 'run with --expose-gc')
// Input is flattened before measuring; only generation allocation is measured.
const large = ('line contents for summary\n').repeat(200_000)
large.charCodeAt(large.length - 1)
global.gc()
const beforeGeneration = process.memoryUsage().heapUsed
const result = summarizeFoldedCode(large)
const generationDelta = process.memoryUsage().heapUsed - beforeGeneration
assert.deepEqual(result, { lineCount: 200_000, preview: 'line contents for summary' })
assert.ok(generationDelta < 4 * 1024 * 1024, `generation allocated ${generationDelta} bytes`)

// Keep only summaries, not the synthetic input strings; a substring backed by
// even one full input would retain megabytes after GC. Each input is unique.
global.gc()
const beforeRetention = process.memoryUsage().heapUsed
function makeSummaries(): Array<{ lineCount: number; preview: string }> {
  const summaries: Array<{ lineCount: number; preview: string }> = []
  for (let i = 0; i < 12; i++) {
    const text = `${String(i).padStart(3, '0')}${'x'.repeat(3_000_000)}\n`
    summaries.push(summarizeFoldedCode(text))
  }
  return summaries
}
const summaries = makeSummaries()
// Let V8 clear transient stack roots from the producer before measuring.
await new Promise<void>(resolve => setImmediate(resolve))
global.gc()
const retainedDelta = process.memoryUsage().heapUsed - beforeRetention
assert.equal(summaries.length, 12)
assert.ok(summaries.every((value, i) => value.lineCount === 1 && value.preview === `${String(i).padStart(3, '0')}${'x'.repeat(157)}…`))
assert.ok(retainedDelta < 2 * 1024 * 1024, `summaries retained ${retainedDelta} bytes`)
console.log(`folded summary: ${fixtures.length} fixtures + 65536 UTF-16 units x 3 + 10000 differential cases; generation delta ${generationDelta} bytes, retained delta ${retainedDelta} bytes`)
