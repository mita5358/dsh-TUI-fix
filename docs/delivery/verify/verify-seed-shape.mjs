#!/usr/bin/env node
// 校验种子形状：未加载的块只落一行 collapsed 摘要，不再伪造 user 占位行。
//
//   DSH_TUI_LIB=<profile>/node_modules/@deepseek-harness-tui/dsh-tui/lib/types \
//   DSH_SESSION_LOG=<session>/session.v4.jsonl.zstd \
//   node verify/verify-seed-shape.mjs
//
// 退出码 0 = 形状符合契约。

import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const LIB = process.env.DSH_TUI_LIB
const SRC = process.env.DSH_SESSION_LOG
if (!LIB || !SRC) {
  console.error('set DSH_TUI_LIB and DSH_SESSION_LOG')
  process.exit(2)
}

const { createDshTranslator } = await import(`${LIB}/dsh-adapter/backend/translate.js`)
const { planChunks, placeholderRows } = await import(`${LIB}/dsh-adapter/backend/history-chunks.js`)

// v4 日志是拼接的 zstd frame；按 frame magic 切开逐个解压。
const frameMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const buf = readFileSync(SRC)
const starts = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === frameMagic[0] && buf[i + 1] === frameMagic[1] && buf[i + 2] === frameMagic[2] && buf[i + 3] === frameMagic[3]) starts.push(i)
}
const raw = []
for (let i = 1; i < starts.length; i++) {
  const end = i + 1 < starts.length ? starts[i + 1] : buf.length
  for (const line of zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8').split('\n')) {
    if (line) raw.push(JSON.parse(line))
  }
}

const translator = createDshTranslator(() => ({ tools: () => undefined, scope: () => undefined, attachments: () => undefined }))
const entries = translator.translateReplay(raw, { present: false })
const chunks = planChunks(entries)
const collapsedChunks = chunks.slice(0, -1) // 最新一块直接投影，不落摘要

let total = 0
let userRows = 0
let collapsedRows = 0
const failures = []
const indexed = []
for (const chunk of collapsedChunks) {
  const rows = placeholderRows(chunk, ch => `⏸ rounds ${ch.fromRound}–${ch.toRound}`, entries)
  indexed.push(...(rows[0]?.collapsedTurns ?? []))
  total += rows.length
  userRows += rows.filter(row => row.kind === 'user').length
  collapsedRows += rows.filter(row => row.collapsed === true).length
  if (rows.length !== 1) failures.push(`chunk ${chunk.index}: ${rows.length} rows, want 1`)
  else if (rows[0].id !== chunk.idBase) failures.push(`chunk ${chunk.index}: id ${rows[0].id}, want ${chunk.idBase}`)
  else if (rows[0].kind !== 'notice') failures.push(`chunk ${chunk.index}: kind ${rows[0].kind}, want notice`)
  else if (rows[0].collapsed !== true || rows[0].restored !== true) failures.push(`chunk ${chunk.index}: collapsed/restored flags missing`)
  else if (rows[0].seq !== undefined || rows[0].anchor !== undefined) failures.push(`chunk ${chunk.index}: digest row must not carry seq/anchor`)
}

console.log(`chunks ${chunks.length} / collapsed ${collapsedChunks.length}`)
console.log(`seed rows ${total} · of which user ${userRows} · collapsed-flagged ${collapsedRows}`)
if (collapsedChunks.length > 0) {
  const { collapsedTurns, ...sample } = placeholderRows(collapsedChunks[0], ch => `⏸ rounds ${ch.fromRound}–${ch.toRound}`, entries)[0]
  console.log('sample', { ...sample, indexedTurns: collapsedTurns.length })
}

const olderEnd = chunks.at(-1)?.start ?? 0
const expected = entries.slice(0, olderEnd).filter(event =>
  event.type === 'user.message' && event.source === 'user' && (event.text !== '' || (event.images?.length ?? 0) > 0))
if (indexed.length !== expected.length || indexed.some((turn, index) => turn.seq !== expected[index]?.seq)) {
  failures.push('collapsed navigation index must cover every older human prompt in record order')
}
if (new Set(indexed.map(turn => turn.id)).size !== indexed.length) failures.push('duplicate reveal handles')
if (indexed.some(turn => turn.id >= chunks[0].idBase)) failures.push('reveal handle collides with chunk rows')
const newestTurns = entries.slice(olderEnd).filter(event =>
  event.type === 'user.message' && event.source === 'user' && (event.text !== '' || (event.images?.length ?? 0) > 0)).length
console.log(`rail index older ${indexed.length} + newest ${newestTurns} = ${indexed.length + newestTurns} human turns`)

if (userRows !== 0) failures.push(`${userRows} fake user rows in the seed`)
if (collapsedRows !== collapsedChunks.length) failures.push(`collapsed rows ${collapsedRows}, want ${collapsedChunks.length}`)
if (total !== collapsedChunks.length) failures.push(`seed rows ${total}, want one per chunk (${collapsedChunks.length})`)

if (failures.length > 0) {
  for (const f of failures) console.error('FAIL ' + f)
  process.exit(1)
}
console.log('SEED SHAPE OK')
