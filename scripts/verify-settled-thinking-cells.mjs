/** Grapheme-safe folded thinking widths and hint priority.
 * Run: node --import tsx/esm scripts/verify-settled-thinking-cells.mjs
 */
import assert from 'node:assert/strict'
import { fitThinkingRow } from '../src/components/messages/settledThinkingSummary.ts'
import { stringWidth } from '../src/ink/stringWidth.ts'
import { getGraphemeSegmenter } from '../src/utils/intl.ts'

const input = {
  marker: '⚓', label: 'Thinking', preview: '开始👩‍👩‍👧‍👦e\u0301🇨🇳🇺🇸…',
  ctrlHint: '(Ctrl+O to expand)', clickHint: '(click to expand)', width: 100,
}
const full = '⚓ Thinking 开始👩‍👩‍👧‍👦e\u0301🇨🇳🇺🇸… (Ctrl+O to expand) (click to expand)'
assert.equal(fitThinkingRow(input), full)
const minimumHints = stringWidth(`${input.marker} ${input.ctrlHint} ${input.clickHint}`)
const previewGraphemes = [...getGraphemeSegmenter().segment(input.preview)].map(x => x.segment)
for (let width = 0; width <= 100; width++) {
  const row = fitThinkingRow({ ...input, width })
  assert.ok(stringWidth(row) <= width, `${width}: ${stringWidth(row)} ${row}`)
  assert.doesNotMatch(row, /[\r\n\x00-\x1f\x7f-\x9f\u2028\u2029]/u)
  if (width >= minimumHints) {
    assert.ok(row.includes(input.marker), `marker lost at ${width}`)
    assert.ok(row.includes(input.ctrlHint), `ctrl hint lost at ${width}`)
    assert.ok(row.includes(input.clickHint), `click hint lost at ${width}`)
  }
  // Every displayed body grapheme must be a whole prefix of the original.
  const title = `${input.marker} ${input.label}`
  if (row.startsWith(title)) {
    let shown = row.slice(title.length)
    for (const hint of [input.ctrlHint, input.clickHint]) shown = shown.replace(` ${hint}`, '')
    shown = shown.trim().replace(/…$/u, '')
    const prefix = [...getGraphemeSegmenter().segment(shown)].map(x => x.segment)
    assert.deepEqual(prefix, previewGraphemes.slice(0, prefix.length), `broken grapheme at width ${width}`)
  }
  if (row.includes('👩')) assert.ok(row.includes('👩‍👩‍👧‍👦'), `split ZWJ at ${width}`)
}
// A non-clickable body must not invent a click affordance.
assert.ok(!fitThinkingRow({ ...input, clickHint: '', width: 100 }).includes('click to expand'))
assert.throws(() => fitThinkingRow({ ...input, preview: 'unsafe\nsecond' }))
console.log('PASS: 101 cell widths, project Intl/stringWidth, whole ZWJ/flags/combining, both hints where physically possible')
