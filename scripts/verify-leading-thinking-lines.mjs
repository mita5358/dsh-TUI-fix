/** Bounded first-nonblank reasoning preview and control-sequence safety.
 * Run: node --import tsx/esm scripts/verify-leading-thinking-lines.mjs
 */
import assert from 'node:assert/strict'
import { settledThinkingHead as summarize } from '../src/components/messages/settledThinkingSummary.ts'
const E = '\x1b', B = '\x07', ST = `${E}\\`
const cases = [
  ['\nHello\nTAIL', 'Hello…'],
  ['\r\n \t \r\n\u2028\u2029首😀\nTAIL', '首😀…'],
  ['\n\n', '…'],
  ['  \t\n  \t', '…'],
  [`${E}[31m  ${E}[0m\nFIRST\nTAIL`, 'FIRST…'],
  [`\n${E}]52;c;HIDDEN\nHIDDEN${B}\nFIRST\nTAIL`, 'FIRST…'],
  [`${E}PSECRET\nSECRET${ST}\nFIRST\nTAIL`, 'FIRST…'],
  [`\n${E}]52;c;UNFINISHED\nSECRET`, '…'],
  [`\n${E}PUNFINISHED\nSECRET`, '…'],
  [`\n${E}[31\nBODY_ONLY_TAIL`, '…'],
  [`${E}[31mhello\nBODY_ONLY_TAIL`, 'hello…'],
  [`\nhello${E}]0;HIDDEN\nHIDDEN${B} end\nTAIL`, 'hello end…'],
  [`\nhello${E}PSECRET\nSECRET${ST} end\nTAIL`, 'hello end…'],
  ['\n'.repeat(4096) + 'SECRET', '…'],
  ['\n'.repeat(4095) + 'X', 'X…'],
  ['\n'.repeat(4095) + 'XSECRET', '…'],
  ['\n'.repeat(4094) + 'XY\nSECRET', 'X…'],
  ['\n'.repeat(4095) + '😀SECRET', '…'],
  ['\n'.repeat(4094) + `${E}[52;c;SECRET`, '…'],
  ['\nX' + 'a' + '\u0301'.repeat(10000), 'X…'],
  ['\nX👩' + '\u200d👩'.repeat(10000), 'X…'],
]
for (const [input, expected] of cases) assert.equal(summarize(input), expected, JSON.stringify(input.slice(0, 40)))
// Stop immediately after actual first nonempty line, even through CSI/newlines.
for (const brk of ['\r', '\n', '\u2028', '\u2029']) {
  assert.equal(summarize(`\nhead${brk}BODY_ONLY_TAIL`), 'head…')
  assert.equal(summarize(`\nhead${E}[31${brk}BODY_ONLY_TAIL`), brk === '\r' || brk === '\n' ? 'head…' : 'hea…')
}
// Every prefix truncation of string controls before content is fail closed.
for (const sequence of [`${E}]0;title${B}`, `${E}]8;;url${ST}`, `${E}]52;c;payload${B}`, `${E}Ppayload${ST}`, '\x9d52;c;payload\x9c', '\x90payload\x9c']) {
  for (let cut = 1; cut < sequence.length; cut++) {
    const value = summarize('\n' + sequence.slice(0, cut))
    assert.equal(value, '…', `${JSON.stringify(sequence)} cut=${cut}`)
    assert.doesNotMatch(value, /[\x00-\x1f\x7f-\x9f]/u)
  }
}
// Confirm the actual raw source never has charCodeAt called beyond 4095.
for (const text of [
  '\n'.repeat(10_000) + 'SECRET',
  '\n'.repeat(4095) + '😀SECRET',
  '\n'.repeat(100) + `${E}]52;c;` + 'x'.repeat(10_000) + B + 'SECRET',
]) {
  const original = String.prototype.charCodeAt
  let max = -1
  try {
    String.prototype.charCodeAt = function (offset) {
      if (String(this) === text) { max = Math.max(max, offset); assert.ok(offset < 4096, `out of bounds ${offset}`) }
      return original.call(this, offset)
    }
    summarize(text)
  } finally { String.prototype.charCodeAt = original }
  assert.ok(max <= 4095 && max >= 0, `max=${max}`)
}
// Independent oracle for small, well-formed control sequences and normal text.
const seg = new Intl.Segmenter('en', { granularity: 'grapheme' })
function oracle(text) {
  const visible = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
  const first = visible.split(/[\r\n\u2028\u2029]/u).find(line => line.trim()) ?? ''
  const normalized = first.replace(/\s+/gu, ' ').trim()
  let head = ''
  for (const { segment } of seg.segment(normalized)) {
    if (head.length + segment.length > 160) break
    head += segment
  }
  return `${head.trimEnd()}…`
}
let seed = 123456789
const atoms = ['a', '中', '😀', 'e\u0301', '👩‍💻', '🇨🇳', ' ', '\t', '\n', '\r\n', '\u2028', `${E}[31m`, `${E}[0m`, `${E}]52;c;abc${B}`, `${E}Pdata${ST}`]
for (let trial = 0; trial < 5000; trial++) {
  let input = ''
  for (let j = 0; j < 12; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; input += atoms[seed % atoms.length] }
  assert.equal(summarize(input), oracle(input), `oracle trial ${trial}`)
}
// Prefixing blank lines must not change the summary of a nonblank first line.
for (let trial = 0; trial < 5000; trial++) {
  let input = 'HEAD'
  for (let j = 0; j < 10; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; input += atoms[seed % atoms.length] }
  assert.equal(summarize('\n \t\r\n' + input), summarize(input), `prefixed trial ${trial}`)
}
console.log(`PASS: ${cases.length} edge cases, all control-string prefix cuts, scan index <4096 and 10000 generated cases`)
