/**
 * Focused slash and punctuation regression. The timing check compares the
 * actual fileTarget export to the same-process legacy oracle; deterministic
 * operation-count and output/OSC8 checks are independent hard requirements.
 * Run serially: nice -n 10 node --import tsx/esm scripts/verify-file-target-slash-performance.ts
 */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { fileLinkUrl, linkifyFilePaths, looksLikeFilePath } from '../src/utils/fileTarget.js'
import { createHyperlink } from '../src/terminal-utils/hyperlink.js'

type Wrap = (path: string, display: string) => string
const pattern = /(?:\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])[^\s<>"'`|?#]*|(?:[^\s<>"'`|?#]*[\\/][^\s<>"'`|?#]*\.[A-Za-z0-9]{1,6})/gu
function legacy(text: string, wrap: Wrap): string {
  if (!text.includes('/') && !text.includes('\\')) return text
  return text.replace(pattern, (match: string, offset: number, full: string) => {
    if (offset > 0 && !/[\s<>"'`|([{=]/u.test(full[offset - 1]!)) return match
    const display = match.replace(/[.,;:!?]+$/u, '')
    if (display === '' || !looksLikeFilePath(display)) return match
    return wrap(display, display) + match.slice(display.length)
  })
}
// Keep the old-version run meaningful: missing candidate module is recorded,
// not substituted with a hand-written guard or silently skipped. Raw legacy
// and actual-source timings are still reported before the gate fails.
let scanner: typeof import('../src/utils/pathSpan.js') | undefined
let missingScanner: unknown
try { scanner = await import('../src/utils/pathSpan.js') }
catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('pathSpan')) throw error
  missingScanner = error
}
const noWrap: Wrap = () => { throw new Error('adversarial input must not invoke wrap') }
const fixtures = [
  { name: 'trailing-slash', value: 'a'.repeat(8000) + '/' },
  { name: 'failed-punctuation-tail', value: '/' + '.'.repeat(4000) + 'x' },
]
const samples: Record<string, { source: number[]; legacy: number[] }> = {}
for (const { name, value } of fixtures) {
  const raw = samples[name] = { source: [], legacy: [] }
  for (const size of [64, 128]) {
    const input = value.slice(0, size)
    assert.equal(linkifyFilePaths(input, noWrap), legacy(input, noWrap), `${name} warmup`)
  }
  const sample = (label: 'source' | 'legacy', fn: (text: string, wrap: Wrap) => string) => {
    const start = performance.now()
    const output = fn(value, noWrap)
    const elapsed = performance.now() - start
    assert.equal(output, value, `${name} ${label} must preserve output`)
    raw[label].push(elapsed)
  }
  for (let round = 0; round < 5; round++) {
    if (round % 2 === 0) { sample('legacy', legacy); sample('source', linkifyFilePaths) }
    else { sample('source', linkifyFilePaths); sample('legacy', legacy) }
  }
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
for (const [name, raw] of Object.entries(samples)) {
  const source = median(raw.source)
  const reference = median(raw.legacy)
  console.log(`PERF ${name} raw_ms=${JSON.stringify(raw)} source_median=${source} legacy_median=${reference} ratio=${source / reference}`)
  assert.ok(reference > 0 && Number.isFinite(reference), `${name}: legacy timing is not measurable`)
  // A noisy runner can fail this relative gate and must be investigated.
  assert.ok(source < reference * 0.5, `${name}: source is not substantially faster than same-process legacy`)
}

// Deterministic gates measure the SAME exported scanner/trim helpers used by
// fileTarget, not a test-side scanner. The old checkout lacks these exports.
assert.ok(scanner, `candidate scan helpers unavailable: ${String(missingScanner)}`)
for (const n of [1000, 4000, 8000, 100000]) {
  for (const input of ['a'.repeat(n) + '/', '/' + 'a'.repeat(n), '/' + '.'.repeat(n) + 'x']) {
    const stats = { steps: 0 }
    const found = [...scanner.scanPathSpans(input, stats)]
    assert.ok(stats.steps <= 4 * input.length + 8, `scanner step bound ${stats.steps}/${input.length}`)
    assert.ok(found.length >= 1, 'slash adversary must exercise actual path-span matching')
    assert.equal(linkifyFilePaths(input, noWrap), input, 'candidate must preserve adversarial content')
  }
  const failed = '/' + '.'.repeat(n) + 'x'
  const failedStats = { inspected: 0 }
  assert.equal(scanner.trailingPathPunctuationStart(failed, failedStats), failed.length)
  assert.equal(failedStats.inspected, 1)
  const validPath = './src/文件.ts'
  const suffix = '!'.repeat(n)
  const suffixStats = { inspected: 0 }
  assert.equal(scanner.trailingPathPunctuationStart(validPath + suffix, suffixStats), validPath.length)
  assert.equal(suffixStats.inspected, n + 1)
  const out = linkifyFilePaths(validPath + suffix, (path, display) => createHyperlink(fileLinkUrl(path), display, { supportsHyperlinks: true, style: s => s }))
  const targets = [...out.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map(match => match[1]!).filter(Boolean)
  assert.deepEqual(targets, [fileLinkUrl(validPath)])
  assert.ok(out.endsWith(suffix), 'long punctuation suffix must remain visible')
}
console.log('PASS slash/punctuation operation, semantics, OSC8 and relative-speed checks')
