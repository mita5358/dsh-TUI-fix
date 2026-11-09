/**
 * Chunked seed integrity oracle: projecting a record chunk by chunk must
 * reproduce exactly the same rows as projecting it in one pass — same count,
 * same kind/text/tool/anchor sequence (row ids excluded; they are renumbered).
 *
 *   DSH_TUI_LIB=<pkg>/lib/types \
 *   DSH_SESSION_LOG=<session>.jsonl.zstd \
 *   node verify-seed-integrity.mjs
 *
 * DSH_TUI_LIB defaults to this repo's build output, DSH_SESSION_LOG to the
 * titan record used during development.
 */
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const LIB = process.env.DSH_TUI_LIB ?? '/home/Administrator/Coding/dsh-TUI/lib/types'
const SRC = process.env.DSH_SESSION_LOG ??
  '/tmp/dsh-mirror/dsh-home/sessions/--home-Administrator-Coding--/4f91acc4-b674-5ba5-beb3-a012a79f366f/session.v4.jsonl.zstd'

const { createDshTranslator } = await import(`${LIB}/dsh-adapter/backend/translate.js`)
const { planChunks } = await import(`${LIB}/dsh-adapter/backend/history-chunks.js`)
const { projectHistorySlice } = await import(`${LIB}/channel/history-restore.js`)

const buf = readFileSync(SRC)
const starts = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
}
const raw = []
for (let i = 1; i < starts.length; i++) {
  const end = i + 1 < starts.length ? starts[i + 1] : buf.length
  for (const line of zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8').split('\n')) {
    if (line) raw.push(JSON.parse(line))
  }
}
const deps = () => ({ tools: () => undefined, scope: () => undefined, attachments: () => undefined })
const entries = createDshTranslator(deps()).translateReplay(raw, { present: false })
const chunks = planChunks(entries)
console.log(`raw events ${raw.length} / entries ${entries.length} / chunks ${chunks.length}`)

/** Stable projection of one row: everything the user can see, no ids. */
function signature(row) {
  return JSON.stringify([
    row.kind,
    row.text ?? '',
    row.tool?.name ?? '',
    row.tool?.callId ?? '',
    row.tool?.arguments ?? '',
    row.tool?.result ?? '',
    row.anchor ?? '',
    row.reasoning ?? '',
    row.folded === true,
    (row.details ?? []).length,
  ])
}

let failures = 0
for (const fold of ['auto', 'full']) {
  const t0 = performance.now()
  const whole = projectHistorySlice(entries, fold)
  const wholeMs = performance.now() - t0
  const t1 = performance.now()
  const sliced = chunks.flatMap(chunk => projectHistorySlice(entries.slice(chunk.start, chunk.end), fold))
  const slicedMs = performance.now() - t1
  const a = whole.map(signature)
  const b = sliced.map(signature)
  let firstDiff = -1
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) { firstDiff = i; break }
  const same = firstDiff < 0 && a.length === b.length
  console.log(`fold=${fold}: whole ${whole.length} rows (${wholeMs.toFixed(0)} ms) / chunked ${sliced.length} rows (${slicedMs.toFixed(0)} ms) -> ${same ? 'MATCH' : 'DIFF'}`)
  if (!same) {
    failures += 1
    if (firstDiff >= 0) {
      console.log(`  first diff at row ${firstDiff}`)
      console.log(`  whole:  ${a[firstDiff]?.slice(0, 300)}`)
      console.log(`  chunked:${b[firstDiff]?.slice(0, 300)}`)
    }
  }
}
console.log(failures === 0 ? 'SEED INTEGRITY OK' : `SEED INTEGRITY FAILED (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
