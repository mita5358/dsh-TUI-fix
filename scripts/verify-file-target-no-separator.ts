/**
 * File-path linkification: compare the real source with the previous matcher
 * on synthetic text, including OSC8 targets and callback/reentrancy behavior.
 * A bounded relative check catches quadratic work on words without separators;
 * paths containing separators are intentionally not covered by that budget.
 * Run serially: node --import tsx/esm scripts/verify-file-target-no-separator.ts
 */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

process.env.TERM_PROGRAM = 'kitty'
process.env.FORCE_COLOR = '3'
const sourceModule = await import('../src/utils/fileTarget.js')
const { looksLikeFilePath, fileLinkUrl } = sourceModule
// This is the actual production export under test, not a hand-written guard.
const sourceFn: (text: string, wrap: Wrap) => string = sourceModule.linkifyFilePaths
assert.equal(typeof sourceFn, 'function')
assert.equal(sourceFn, sourceModule.linkifyFilePaths)
const { createHyperlink } = await import('../src/terminal-utils/hyperlink.js')
type Wrap = (path: string, display: string) => string
const oldPattern = /(?:\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])[^\s<>"'`|?#]*|(?:[^\s<>"'`|?#]*[\\/][^\s<>"'`|?#]*\.[A-Za-z0-9]{1,6})/gu
// Literal legacy algorithm and regex, but the real source looksLikeFilePath:
// the oracle does not speculate about current path acceptance rules.
function legacy(text: string, wrap: Wrap): string {
  return text.replace(oldPattern, (match: string, offset: number, full: string) => {
    if (offset > 0 && !/[\s<>"'`|([{=]/u.test(full[offset - 1]!)) return match
    const display = match.replace(/[.,;:!?]+$/u, '')
    if (display === '' || !looksLikeFilePath(display)) return match
    return wrap(display, display) + match.slice(display.length)
  })
}
type Outcome =
  | { ok: true; value: string; calls: string[][] }
  | { ok: false; errorType: string; errorName: string; errorMessage: string; calls: string[][] }
function observe(fn: (s: string, wrap: Wrap) => string, text: string, osc: boolean): Outcome {
  const calls: string[][] = []
  let nested = false
  const wrap: Wrap = (path, display) => {
    calls.push(['outer-before', path, display])
    if (!nested) {
      nested = true
      calls.push(['nested-before'])
      const inner = fn('nested ./src/file.ts and C:\\dir\\file.txt', (p, d) => {
        calls.push(['inner-before', p, d])
        const value = `<${p}|${d}>`
        calls.push(['inner-after', p, d, value])
        return value
      })
      calls.push(['nested-after', inner])
    }
    // If a callback unexpectedly throws, preserve the preceding callback
    // side effects and absence of outer-after for differential comparison.
    const value = osc
      ? createHyperlink(fileLinkUrl(path), display, { supportsHyperlinks: true, style: s => s })
      : `{${path}|${display}}`
    calls.push(['outer-after', path, display, value])
    return value
  }
  try {
    return { ok: true, value: fn(text, wrap), calls }
  } catch (error) {
    return {
      ok: false,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorName: error instanceof Error ? error.name : '',
      errorMessage: error instanceof Error ? error.message : String(error),
      calls,
    }
  }
}
function compare(text: string): void {
  for (const osc of [false, true]) {
    const actual = observe(sourceFn, text, osc)
    const expected = observe(legacy, text, osc)
    assert.deepEqual(actual, expected, `${osc ? 'real OSC8' : 'replacement'} result/error/callback order mismatch: ${JSON.stringify(text)}`)
    if (!text.includes('/') && !text.includes('\\')) assert.deepEqual(actual.calls, [], 'no-separator text must not call wrap')
  }
}
// Malformed UTF-16 must remain the exact original JS string, never enter
// wrap or become any OSC8 target. Real UTF-8 transport displays U+FFFD.
for (const bad of ['a\ud800/b.ts', 'a\udc00/b.ts']) {
  assert.equal(looksLikeFilePath(bad), false, 'malformed UTF-16 must not be accepted as a file target')
  const source = observe(sourceFn, bad, true)
  const expected = observe(legacy, bad, true)
  assert.deepEqual(source, expected)
  assert.equal(source.ok, true, 'malformed UTF-16 must not throw')
  if (source.ok) {
    assert.equal(source.value, bad, 'the original JS string must be preserved')
    assert.ok(!source.value.includes('\x1b]8;'), 'no malformed path may become a hyperlink')
    assert.equal(Buffer.from(source.value, 'utf8').toString('utf8'), 'a\ufffd/b.ts', 'UTF-8 transport must leave readable replacement text')
  }
  assert.deepEqual(source.calls, [], 'malformed path must not invoke wrap')
  console.log(`PASS malformed UTF-16 preserved without wrap: ${JSON.stringify(bad)}`)
}
// A valid Unicode path must really reach the real OSC8 writer; equivalent
// exceptions or empty/plain output are not accepted as a passing test.
for (const unicodePath of ['./src/文件.ts', './src/🐋.ts']) {
  assert.equal(looksLikeFilePath(unicodePath), true, 'valid Unicode path must remain eligible')
  for (const fn of [sourceFn, legacy]) {
    const result = observe(fn, unicodePath, true)
    assert.equal(result.ok, true, 'valid Unicode path must render successfully')
    if (result.ok) {
      const hrefs = [...result.value.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map(match => match[1]!).filter(Boolean)
      assert.deepEqual(hrefs, [fileLinkUrl(unicodePath)], 'valid Unicode OSC8 target must be exact')
      assert.ok(result.value.includes(unicodePath), 'valid Unicode path label must remain visible')
    }
  }
}
for (const text of [
  '', 'ordinary prose 🐋', '汉\u00a0字\u2028x\ufeffy', 'x'.repeat(256),
  './src/file.ts-backup', 'src/index.ts.', '../x', '.../a.b', 'abc/z.a/y.b',
  '/a/b', '~/.config/a', 'C:\\dir\\file.txt', '\\server\\share\\a.ts', 'x\\y.z',
  'owner/repo#123456789', 'https://example.com/src/file.ts', 'www.example.org/a/b.ts',
  '(./src/foo.ts),', '=src/file.js;', 'prefix./a/file.ts',
  'a\ud800/b.ts', 'a\udc00/b.ts', '🐋/file.ts', '字/文件.ts',
]) compare(text)
let seed = 0x4e6f6465
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
const alphabet = ['a','Z','0','.','/','\\','~',':','#','?','!',',',';','=','(',')','[',']','"',"'",'`','|','*','@',' ','\t','\n','\u00a0','\u2028','\ufeff','🐋','汉','\ud800','\udc00']
for (let n = 0; n < 6000; n++) {
  let text = ''
  const size = random() % 100
  for (let i = 0; i < size; i++) text += alphabet[random() % alphabet.length]
  compare(text)
}
const marker = new Error('callback marker')
for (const fn of [sourceFn, legacy]) {
  const calls: string[] = []
  assert.throws(() => fn('./src/file.ts', (path: string) => {
    calls.push(path)
    fn('no separators 🐋', () => { throw new Error('unexpected nested callback') })
    throw marker
  }), error => error === marker)
  assert.deepEqual(calls, ['./src/file.ts'])
}
console.log('PASS file-path semantic and OSC8 differential')

// Same 8k fixture, same process, alternating order. 3 raw samples each;
// timings are diagnostic only until all semantic checks passed. The fixed-size
// fixture runs as a serial gate. It deliberately does NOT benchmark any
// slash-containing text or claim its complexity improved.
const input = 'q'.repeat(8000)
const noWrap: Wrap = () => { throw new Error('no-slash word must not invoke wrap') }
for (const size of [128, 256]) { assert.equal(sourceFn(input.slice(0, size), noWrap), input.slice(0, size)); assert.equal(legacy(input.slice(0, size), noWrap), input.slice(0, size)) }
const raw: Record<'source' | 'legacy', number[]> = { source: [], legacy: [] }
const run = (name: 'source' | 'legacy', fn: typeof sourceFn) => {
  const start = performance.now()
  const result = fn(input, noWrap)
  const ms = performance.now() - start
  assert.equal(result, input)
  raw[name].push(ms)
}
for (let i = 0; i < 3; i++) {
  if (i % 2 === 0) { run('legacy', legacy); run('source', sourceFn) }
  else { run('source', sourceFn); run('legacy', legacy) }
}
const median = (v: number[]) => [...v].sort((a, b) => a - b)[1]!
const sourceMedian = median(raw.source)
const legacyMedian = median(raw.legacy)
console.log(`PERF raw_ms=${JSON.stringify(raw)} source_median_ms=${sourceMedian} legacy_median_ms=${legacyMedian} ratio=${sourceMedian / legacyMedian}`)
assert.ok(Number.isFinite(legacyMedian) && legacyMedian > 0, 'legacy timing is unmeasurable; report inconclusive')
// Intentionally loose relative gate, not an absolute machine-specific budget.
// On the current unguarded source sourceFn should perform like legacy and fail;
// after the actual guard is applied to production source it should pass.
assert.ok(sourceMedian < legacyMedian * 0.5, 'source no-slash path is not substantially faster than same-process legacy oracle')
console.log('PASS real-source no-separator relative performance')
