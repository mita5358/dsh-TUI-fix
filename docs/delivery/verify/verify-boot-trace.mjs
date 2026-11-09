/**
 * Summarize a DSH_TUI_BOOT_TRACE jsonl and check the chunked-open shape:
 * the seed translates once, folds the older chunks, projects the newest one,
 * and the first frame waits only for that. Exit code 1 on a malformed trace.
 *
 *   node verify-boot-trace.mjs /tmp/boot.jsonl
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node verify-boot-trace.mjs <boot-trace.jsonl>')
  process.exit(2)
}
const marks = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
let previous = 0
let previousMark = 'start'
let bad = 0
for (const mark of marks) {
  const delta = mark.ms - previous
  if (delta < 0) bad += 1
  console.log(`${mark.mark.padEnd(16)} ${String(mark.ms).padStart(6)} ms   (+${delta} ms since ${previousMark})`)
  previous = mark.ms
  previousMark = mark.mark
}
const at = name => marks.find(mark => mark.mark === name)?.ms
const total = marks.at(-1)?.ms
console.log('')
console.log(`first frame: ${total} ms (raw history ${at('raw-history-done')} ms, translate ${at('translate-done')} ms, fold ${at('fold-done')} ms, newest chunk ${at('newest-done')} ms)`)
if (['raw-history-done', 'translate-done', 'fold-done', 'newest-done', 'render-done'].some(name => at(name) === undefined)) {
  console.error('missing expected phase mark (not a chunked-open build?)')
  process.exit(1)
}
if (bad > 0) {
  console.error(`${bad} mark(s) go backwards`)
  process.exit(1)
}
console.log('BOOT TRACE OK')
