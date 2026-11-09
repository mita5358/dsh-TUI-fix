/** Differential coverage for the live thinking ticker's bounded line array.
 * Run: node --import tsx/esm scripts/verify-thinking-ticker-tail.ts
 */
import assert from 'node:assert/strict'
import { thinkingTickerTail } from '../src/components/messages/thinkingTicker.js'

function oldTail(text: string, count: number) {
  const lines = text.split('\n')
  const visible = lines.slice(-count)
  return { lines: visible, clipped: lines.length > visible.length }
}

let checked = 0
const alphabet = ['x', '\n', '\r', '😀', '\u2028']
function check(text: string) {
  for (let count = 1; count <= 5; count++) {
    assert.deepEqual(thinkingTickerTail(text, count), oldTail(text, count), `count=${count} text=${JSON.stringify(text)}`)
    checked++
  }
}
function enumerate(prefix: string, remaining: number) {
  check(prefix)
  if (remaining > 0) for (const char of alphabet) enumerate(prefix + char, remaining - 1)
}
enumerate('', 6)
for (const text of ['', '\n', '\n\n', '\n\n\n', 'a\n', 'a\r\nb\n', '\0\n\ud800\n\udc00', 'z'.repeat(50_000), ('line\n').repeat(20_000)]) check(text)

// The new implementation must not allocate one array entry per old line.
const originalSplit = String.prototype.split
const sentinel = `prefix-${'line\n'.repeat(100)}tail`
try {
  String.prototype.split = function (...args: Parameters<typeof originalSplit>) {
    if (String(this) === sentinel) throw new Error('split the entire ticker')
    return originalSplit.apply(this, args)
  }
  assert.deepEqual(thinkingTickerTail(sentinel, 3), { lines: ['line', 'line', 'tail'], clipped: true })
} finally {
  String.prototype.split = originalSplit
}
console.log(`thinking ticker tail: ${checked} differential checks passed`)
