/**
 * Path-span and file-link differential against the original regex semantics.
 * Run: node --import tsx/esm scripts/verify-file-target-linear.ts
 */
import assert from 'node:assert/strict'
import { scanPathSpans as scanSpans, trailingPathPunctuationStart, type PathSpan as Span } from '../src/utils/pathSpan.js'
import { looksLikeFilePath, linkifyFilePaths as integratedLinkifier, fileLinkUrl } from '../src/utils/fileTarget.js'
import { createHyperlink } from '../src/terminal-utils/hyperlink.js'

const pattern = /(?:\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])[^\s<>"'`|?#]*|(?:[^\s<>"'`|?#]*[\\/][^\s<>"'`|?#]*\.[A-Za-z0-9]{1,6})/gu

// Legacy matcher/trim oracle, using the real path validation and wrap.
function linkifyFilePaths(text: string, wrap: Wrap): string {
  if (!text.includes('/') && !text.includes('\\')) return text
  return text.replace(pattern, (match: string, offset: number, full: string) => {
    if (offset > 0 && !/[\s<>"'`|([{=]/u.test(full[offset - 1]!)) return match
    const display = match.replace(/[.,;:!?]+$/u, '')
    if (display === '' || !looksLikeFilePath(display)) return match
    return wrap(display, display) + match.slice(display.length)
  })
}

const forbidden = (c: string) => c === '' || /[\s<>"'`|?#]/u.test(c)
const slash = (c: string | undefined) => c === '/' || c === '\\'
const letter = (c: string | undefined) => c !== undefined && /^[A-Za-z]$/.test(c)
const alphaNum = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9]$/.test(c)
const anchored = (s: string, i: number) => slash(s[i]) || (s[i] === '~' && slash(s[i + 1])) || (s[i] === '.' && (slash(s[i + 1]) || (s[i + 1] === '.' && slash(s[i + 2])))) || (letter(s[i]) && s[i + 1] === ':' && slash(s[i + 2]))
// Previous next-slash table algorithm, with Uint32Array. 0 is sentinel;
// stored slash positions are relative to run start plus 1. No path cutoff.
function tableSpans(full: string): Span[] {
  const result: Span[] = []
  let start = 0
  while (start < full.length) {
    if (forbidden(full[start]!)) { start++; continue }
    let end = start
    while (end < full.length && !forbidden(full[end]!)) end++
    const next = new Uint32Array(end - start + 1)
    let lastDot = -1
    for (let i = end - 1; i >= start; i--) {
      next[i - start] = slash(full[i]) ? i - start + 1 : next[i - start + 1]!
      if (lastDot < 0 && full[i] === '.' && i + 1 < end && alphaNum(full[i + 1])) lastDot = i
    }
    for (let i = start; i < end;) {
      let matchEnd = -1
      if (anchored(full, i)) matchEnd = end
      else {
        const slot = next[i - start]!
        const nextSlash = slot === 0 ? -1 : start + slot - 1
        if (nextSlash >= 0 && nextSlash < lastDot) {
          matchEnd = lastDot + 1
          for (let n = 0; n < 6 && matchEnd < end && alphaNum(full[matchEnd]); n++) matchEnd++
        }
      }
      if (matchEnd < 0) { i++; continue }
      result.push({ offset: i, end: matchEnd }); i = matchEnd
    }
    start = end
  }
  return result
}
function regexSpans(s: string): Span[] {
  return [...s.matchAll(pattern)].map(m => ({ offset: m.index!, end: m.index! + m[0].length }))
}
type Wrap = (path: string, display: string) => string
function replacement(s: string, spans: Iterable<Span>, wrap: Wrap): string {
  let output = ''
  let previous = 0
  for (const { offset, end } of spans) {
    output += s.slice(previous, offset)
    const match = s.slice(offset, end)
    previous = end
    if (offset > 0 && !/[\s<>"'`|([{=]/u.test(s[offset - 1]!)) { output += match; continue }
    const display = match.replace(/[.,;:!?]+$/u, '')
    if (display === '' || !looksLikeFilePath(display)) { output += match; continue }
    output += wrap(display, display) + match.slice(display.length)
  }
  return output + s.slice(previous)
}
function candidate(s: string, wrap: Wrap): string { return replacement(s, scanSpans(s), wrap) }
function observe(fn: (s: string, w: Wrap) => string, s: string, osc: boolean) {
  const calls: string[][] = []
  let nested = false
  const wrap: Wrap = (path, display) => {
    calls.push(['before', path, display])
    if (!nested) {
      nested = true
      calls.push(['nested-before'])
      const inner = fn('open ./src/文件.ts then C:\\work\\x.ts', (p, d) => {
        calls.push(['inner-before', p, d]); const v = `<${p}|${d}>`; calls.push(['inner-after', v]); return v
      })
      calls.push(['nested-after', inner])
    }
    const value = osc ? createHyperlink(fileLinkUrl(path), display, { supportsHyperlinks: true, style: x => x }) : `{${path}|${display}}`
    calls.push(['after', value])
    return value
  }
  try { return { ok: true, value: fn(s, wrap), calls } }
  catch (error) { return { ok: false, type: error instanceof Error ? error.constructor.name : typeof error, name: error instanceof Error ? error.name : '', message: error instanceof Error ? error.message : String(error), calls } }
}
function compareTail(match: string): void {
  const oldDisplay = match.replace(/[.,;:!?]+$/u, '')
  const stats = { inspected: 0 }
  const end = trailingPathPunctuationStart(match, stats)
  assert.equal(match.slice(0, end), oldDisplay)
  assert.equal(match.slice(end), match.slice(oldDisplay.length))
  assert.ok(stats.inspected <= match.length)
}
function compare(s: string): void {
  compareTail(s)
  const stats = { steps: 0 }
  const constant = [...scanSpans(s, stats)]
  const original = regexSpans(s)
  assert.deepEqual(constant, original, `O(1) scanner spans differ: ${JSON.stringify(s)}`)
  assert.deepEqual(tableSpans(s), original, `Uint32 scanner spans differ: ${JSON.stringify(s)}`)
  assert.ok(stats.steps <= 4 * s.length + 8, `linear scan operation bound: ${stats.steps}/${s.length}`)
  // Also verify replacement callback's exact raw matched text, offset and full.
  const reMatches: Array<[string, number, string]> = []
  s.replace(pattern, (match: string, offset: number, full: string) => { reMatches.push([match, offset, full]); return match })
  assert.deepEqual(constant.map(({ offset, end }) => [s.slice(offset, end), offset, s]), reMatches)
  for (const osc of [false, true]) {
    const originalResult = observe(linkifyFilePaths, s, osc)
    assert.deepEqual(observe(candidate, s, osc), originalResult, `standalone wrap effects/OSC8 differ: ${JSON.stringify(s)}`)
    assert.deepEqual(observe(integratedLinkifier, s, osc), originalResult, `integrated wrap effects/OSC8 differ: ${JSON.stringify(s)}`)
  }
}
for (const s of [
  '', 'abc/z.a/y.b', 'abc/z.a/y_without_dot', 'a/b.cdefghi/z', 'a/b.x/y.zfooquux',
  '.../file.ts', '.../..//a', '/a', '/a/b', './a.ts,', '../x.ts', '~/.config/x',
  'C:\\dir\\x.ts', 'x\\y.z', 'x/y.ts!a/z.js', 'x/y.tsabcdefg/z', 'x/y.a..a',
  'https://example.com/src/file.ts', 'owner/repo#123456789', 'a?b/c.ts',
  'a\u00a0b/c.ts', 'a\u2028b/c.ts', 'a\ufeffb/c.ts', '🐋/file.ts',
  'a\ud800/b.ts', 'a\udc00/b.ts', './src/文件.ts', './src/🐋.ts',
]) compare(s)
// Exhaustive 11-character alphabet, strings of length 0..5, includes both
// separators, dot, extension, drive, tilde, excluded character and whitespace.
const alphabet = ['a', 'A', '1', '.', '/', '\\', ':', '~', ' ', '#', '!']
let exhaustiveCases = 0
function enumerate(prefix: string, remaining: number): void {
  compare(prefix); exhaustiveCases++
  if (remaining === 0) return
  for (const c of alphabet) enumerate(prefix + c, remaining - 1)
}
enumerate('', 5)
assert.equal(exhaustiveCases, 1 + 11 + 121 + 1331 + 14641 + 161051)
// Independently retain the punctuation oracle's complete 11-symbol sweep.
const tailAlphabet = ['a', '.', ',', ';', ':', '!', '?', '/', '🐋', '\ud800', '\n']
let tailCases = 0
function enumerateTail(prefix: string, remaining: number): void {
  compareTail(prefix); tailCases++
  if (remaining === 0) return
  for (const c of tailAlphabet) enumerateTail(prefix + c, remaining - 1)
}
enumerateTail('', 5)
assert.equal(tailCases, 1 + 11 + 121 + 1331 + 14641 + 161051)
// Sweep every UTF-16 code unit against the exact /u regex to detect a wrong
// \s/excluded-character table, including both classes of lone surrogate.
for (let unit = 0; unit <= 0xffff; unit++) {
  const s = 'a' + String.fromCharCode(unit) + '/b.ts'
  assert.deepEqual([...scanSpans(s)], regexSpans(s), `code-unit mismatch U+${unit.toString(16).padStart(4, '0')}`)
  compareTail('x' + String.fromCharCode(unit) + '!')
}
// Focused greediness extension lengths, and unicode BMP/astral/lone-surrogate.
for (const n of [1, 2, 5, 6, 7, 8, 12]) for (const s of [`a/b.${'x'.repeat(n)}`, `a/b.${'x'.repeat(n)}/c`, `🐋/a.${'x'.repeat(n)}`]) compare(s)
// Additional composite scanner + tail cases; original exhaustive/random
// oracle and all original cases above remain unchanged.
for (const n of [1, 16, 64, 128, 256]) {
  for (const mark of ['.', '!']) {
    compare('/' + mark.repeat(n) + 'x')
    compare('./src/文件.ts' + mark.repeat(n))
  }
}
let seed = 0x9e3779b9
function random(): number { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
const varied = [...alphabet, '漢', '🐋', '\ud800', '\udc00', '\u1680', '\u2000', '\u2028', '\u202f', '\u205f', '\u3000', '\ufeff', '\t', '\n', '"', "'", '`', '|', '?', '<', '>', '=']
for (let n = 0; n < 20000; n++) {
  const size = random() % 100
  let s = ''
  for (let i = 0; i < size; i++) s += varied[random() % varied.length]
  compare(s)
}
// Throw behavior and visible callback prefix: no blanket catch.
const marker = new Error('wrap marker')
for (const fn of [linkifyFilePaths, candidate, integratedLinkifier]) {
  const calls: string[] = []
  assert.throws(() => fn('./src/file.ts /other/file.ts', (p: string) => {
    calls.push(`outer-before:${p}`)
    const inner = fn('./nested/文件.ts', (q: string) => { calls.push(`inner:${q}`); return `inner(${q})` })
    calls.push(`outer-after-inner:${inner}`)
    throw marker
  }), error => error === marker)
  assert.deepEqual(calls, ['outer-before:./src/file.ts', 'inner:./nested/文件.ts', 'outer-after-inner:inner(./nested/文件.ts)'])
}
for (const path of ['./src/文件.ts', './src/🐋.ts']) {
  for (const fn of [candidate, integratedLinkifier]) {
    const actual = observe(fn, path, true)
    assert.equal(actual.ok, true)
    if (actual.ok) assert.ok(actual.value?.includes(fileLinkUrl(path)), 'real Unicode OSC8 target required')
  }
}
for (const text of ['a\ud800/b.ts', 'a\udc00/b.ts']) {
  for (const fn of [candidate, integratedLinkifier]) {
    const result = observe(fn, text, true)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value, text)
    assert.deepEqual(result.calls, [])
  }
}
// No huge quadratic baseline execution; only candidate known spans & step
// counts, including slash-bearing adversaries absent from the earlier probe.
for (const n of [1000, 4000, 8000, 100000]) {
  for (const [s, expected] of [
    ['a'.repeat(n), []],
    ['a'.repeat(n) + '/', [{ offset: n, end: n + 1 }]],
    ['/' + 'a'.repeat(n), [{ offset: 0, end: n + 1 }]],
    ['a'.repeat(n) + '/x.ts', [{ offset: 0, end: n + 5 }]],
  ] as Array<[string, Span[]]>) {
    const stats = { steps: 0 }
    assert.deepEqual([...scanSpans(s, stats)], expected)
    assert.ok(stats.steps <= 4 * s.length + 8)
  }
  // Old matcher is intentionally NOT invoked on the known quadratic 100k
  // failed-tail shape. The real combined linkifier must preserve it verbatim.
  const failedTail = '/' + '.'.repeat(n) + 'x'
  let wrapped = false
  assert.equal(integratedLinkifier(failedTail, () => { wrapped = true; return 'wrong' }), failedTail)
  assert.equal(wrapped, false)
  const failedStats = { inspected: 0 }
  assert.equal(trailingPathPunctuationStart(failedTail, failedStats), failedTail.length)
  assert.equal(failedStats.inspected, 1)
  const longSuffix = './src/文件.ts' + '!'.repeat(n)
  const suffixStats = { inspected: 0 }
  assert.equal(trailingPathPunctuationStart(longSuffix, suffixStats), './src/文件.ts'.length)
  assert.equal(suffixStats.inspected, n + 1)
}
// A very long successful punctuation suffix must not hide an otherwise
// linkable short path, change its OSC8 target, or discard the suffix.
const longPath = './src/文件.ts'
const longPunctuation = '!,;:.'.repeat(20000)
const longInput = 'open ' + longPath + longPunctuation + ' done'
// Keep 100k input candidate-only; the bounded cases above compare legacy.
const longActual = observe(integratedLinkifier, longInput, true)
assert.equal(longActual.ok, true)
if (longActual.ok && typeof longActual.value === 'string') {
  const targets = [...longActual.value.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map(match => match[1]!).filter(Boolean)
  assert.deepEqual(targets, [fileLinkUrl(longPath)])
  assert.ok(longActual.value.includes(longPunctuation + ' done'))
} else throw new Error('long valid path did not produce rendered output')
// RegExp.replace obtains global matches before callback execution. A callback
// may replace public builtins; later lazy scans must remain semantically stable.
const savedCharCodeAt = String.prototype.charCodeAt
const patchProbe = (fn: (s: string, wrap: Wrap) => string) => {
  const calls: string[] = []
  try {
    const value = fn('./src/a.ts ./src/b.ts', (path: string) => {
      calls.push(path)
      if (calls.length === 1) String.prototype.charCodeAt = function (_index: number) { return 35 }
      return `<${path}>`
    })
    return { value, calls }
  } finally { String.prototype.charCodeAt = savedCharCodeAt }
}
const baselinePatchProbe = patchProbe(linkifyFilePaths)
assert.deepEqual(baselinePatchProbe.calls, ['./src/a.ts', './src/b.ts'])
assert.deepEqual(patchProbe(candidate), baselinePatchProbe, 'standalone wrap side effects must not change later scanner matches')
assert.deepEqual(patchProbe(integratedLinkifier), baselinePatchProbe, 'integrated wrap side effects must not change later scanner matches')
console.log(`PASS scanner differential and bounded operation counts, exhaustive=${exhaustiveCases}`)
