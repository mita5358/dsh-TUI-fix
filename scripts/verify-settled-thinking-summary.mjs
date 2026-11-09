/** Bounded, control-safe first-line digest; includes pre-flattened memory probes.
 * Run: node --expose-gc --import tsx/esm scripts/verify-settled-thinking-summary.mjs
 */
import assert from 'node:assert/strict'
import { settledThinkingHead as summarize } from '../src/components/messages/settledThinkingSummary.ts'
const ESC = '\x1b', BEL = '\x07', ST = `${ESC}\\`
const cases = [
  ['', '…'], ['hi', 'hi…'], ['  a\r\n\tb  ', 'a…'],
  ['START\nBODY_ONLY_MIDDLE\nBODY_ONLY_TAIL', 'START…'],
  ['start\rBODY_ONLY_TAIL', 'start…'],
  ['start\u2028BODY_ONLY_TAIL', 'start…'],
  [`start${ESC}]0;ignore\ninside${BEL}end\nBODY_ONLY_TAIL`, 'startend…'],
  [`start${ESC}Pignore\ninside${ST}end\nBODY_ONLY_TAIL`, 'startend…'],
  [`start${ESC}[31\nBODY_ONLY_TAIL`, 'start…'],
  [`start\x9b31\rBODY_ONLY_TAIL`, 'start…'],
  ['😀猫e\u0301👩‍👩‍👧‍👦!', '😀猫e\u0301👩‍👩‍👧‍👦!…'],
  [`a${ESC}[31mred${ESC}[0mZ`, 'aredZ…'],
  [`a${ESC}]0;evil-title${BEL}z`, 'az…'],
  [`a${ESC}]8;;https://example.test${ST}link${ESC}]8;;${ST}z`, 'alinkz…'],
  [`a${ESC}]52;c;SECRET${BEL}z`, 'az…'],
  [`a${ESC}Pprivate${ST}z`, 'az…'],
  ['a\x9d52;c;SECRET\x9cz', 'az…'],
  ['a\x9b31mred\x9b0mz', 'aredz…'],
  [`hi${ESC}]52;c;LEAK`, 'h…'],
  [`hi${ESC}Punterminated`, 'h…'],
  [`hi${ESC}[31`, 'h…'],
  [`hi${ESC}[31${ESC}LEAK`, 'h…'],
  [`hi${ESC}`, 'h…'],
  ['a\x00\x07\x7f\x80b', 'ab…'],
  ['\ud800X\udc00', '�X�…'],
  ['\u2028\u2029start\u2028next', 'start…'],
  ['x'.repeat(159)+'😀suffix', 'x'.repeat(159)+'…'],
  ['x'.repeat(158)+'😀suffix', 'x'.repeat(158)+'😀…'],
  ['x'.repeat(159)+'e\u0301suffix', 'x'.repeat(159)+'…'],
  ['x'.repeat(158)+'e\u0301suffix', 'x'.repeat(158)+'e\u0301…'],
  ['a'+'\u0301'.repeat(1000)+'b', '…'],
  [' '.repeat(4096)+'tail', '…'],
  ['x'.repeat(4095)+'\ud83d\ude00', 'x'.repeat(160)+'…'],
  [`A${ESC}]52;c;${'x'.repeat(5000)}${BEL}SHOULD_NOT_SHOW`, '…'],
  [`hello${ESC}Psecret${BEL}still-secret${ST}end`, 'helloend…'],
  [`hello${ESC}]0;secret${ST}end`, 'helloend…'],
  [`hello${ESC}Xsecret${ST}end`, 'helloend…'],
  [`hello\x90secret\x9cend`, 'helloend…'],
  ['x'.repeat(157)+'👩‍💻tail', 'x'.repeat(157)+'…'],
  ['x'.repeat(155)+'👩‍💻tail', 'x'.repeat(155)+'👩‍💻…'],
  ['x'.repeat(157)+'🇨🇳tail', 'x'.repeat(157)+'…'],
  ['x'.repeat(156)+'🇨🇳tail', 'x'.repeat(156)+'🇨🇳…'],
  ['x'.repeat(159)+'\ud800\udc00tail', 'x'.repeat(159)+'…'],
]
for (const [input, expected] of cases) assert.equal(summarize(input), expected, JSON.stringify(input.slice(0, 40)))
// Every truncation point of each supported escape: no partial payload escapes.
for (const sequence of [`${ESC}[38;2;255;0;1m`, `${ESC}]0;window-title${BEL}`, `${ESC}]8;;https://secret${ST}`, `${ESC}]52;c;c2VjcmV0${BEL}`, `${ESC}Ppayload${ST}`, `\x9d52;c;secret\x9c`, `\x90payload\x9c`]) {
  for (let i = 0; i <= sequence.length; i++) {
    const result = summarize('safe' + sequence.slice(0, i))
    assert.equal(result, i === 0 || i === sequence.length ? 'safe…' : 'saf…', `control cut ${i} of ${JSON.stringify(sequence)}`)
    assert.doesNotMatch(result, /[\x00-\x1f\x7f-\x9f]/)
  }
}
// A single pathological unbounded cluster is discarded rather than split.
assert.equal(summarize('X' + 'a' + '\u0301'.repeat(20_000)), 'X…')
assert.equal(summarize('X' + '👩' + '\u200d👩'.repeat(10_000)), 'X…')
// Deliberately naive slicing/regex fails on both ANSI and grapheme boundaries.
const naive = text => text.slice(0, 160).replace(/\x1b\[[0-9;]*m/g, '').trim() + '…'
assert.notEqual(naive(`A${ESC}]52;c;SECRET${BEL}B`), 'AB…')
assert.notEqual(naive('x'.repeat(159)+'😀tail'), summarize('x'.repeat(159)+'😀tail'))

// Independent full-string oracle for short, well-formed generated inputs:
// remove complete controls, normalize whitespace, segment, then bound result.
const seg = new Intl.Segmenter('en', { granularity: 'grapheme' })
function oracle(s) {
  const clean = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    .split(/[\r\n\u2028\u2029]/u).find(line => line.trim() !== '') ?? ''
  const normalized = clean
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
    .replace(/\s+/gu, ' ').trim()
  let head = ''
  for (const {segment} of seg.segment(normalized)) {
    if (head.length + segment.length > 160) break
    head += segment
  }
  return `${head.trimEnd()}…`
}
let seed = 123456789
const atoms = ['a','中','😀','e\u0301','👩‍💻','🇨🇳',' ','\t','\n','\u2028',`${ESC}[31m`,`${ESC}[0m`,`${ESC}]52;c;abc${BEL}`,`${ESC}]8;;url${ST}`,`${ESC}Pdata${ST}`]
for (let trial = 0; trial < 5000; trial++) {
  let input = ''
  for (let j = 0; j < 12; j++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    input += atoms[seed % atoms.length]
  }
  assert.equal(summarize(input), oracle(input), `differential trial ${trial}`)
}

assert.ok(global.gc, 'requires --expose-gc')
// Count only summary generation after flattening the source, not source setup.
const flatInput = `hello ${'x'.repeat(8_000_000)}`
flatInput.charCodeAt(flatInput.length - 1)
global.gc()
const generationBefore = process.memoryUsage().heapUsed
assert.ok(summarize(flatInput).startsWith('hello '))
const generationDelta = process.memoryUsage().heapUsed - generationBefore
assert.ok(generationDelta < 1024 * 1024, `unexpected generation allocation ${generationDelta}`)
function makeRetained() {
  const results = []
  for (let i = 0; i < 12; i++) {
    const input = `${i.toString().padStart(3, '0')}${'x'.repeat(3_000_000)}`
    input.charCodeAt(input.length - 1) // preflatten to isolate summary generation
    results.push(summarize(input))
  }
  return results
}
global.gc()
const before = process.memoryUsage().heapUsed
const outputs = makeRetained()
await new Promise(resolve => setImmediate(resolve))
global.gc()
const retained = process.memoryUsage().heapUsed - before
assert.ok(outputs.every((x, i) => x.startsWith(i.toString().padStart(3, '0'))))
assert.ok(retained < 2 * 1024 * 1024, `unexpected retention ${retained}`)
console.log(`PASS: ${cases.length} fixed cases, all control cut points, giant clusters, naive red controls/Unicode, 5000 oracle differential cases; generation delta ${generationDelta} bytes; retained delta ${retained} bytes`)
