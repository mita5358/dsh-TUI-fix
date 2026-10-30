/**
 * Chunked history: the cut plan, the collapsed placeholder rows, and the
 * placeholder → projected-row mapping a rail reveal depends on
 * (`ChannelUi.revealRow`, implemented by the DSH extension's `revealChunkRow`).
 *
 * The regression this guards: a timeline tick on a turn inside a collapsed
 * chunk used to expand the WHOLE record (`showAllMessages`, a 27,907-row
 * relayout, 5.6 GB RSS before the process was killed). A reveal must project
 * only the owning chunk, and must land on the turn's real row — placeholder
 * ids are positional and do not survive materialization, so the mapping is the
 * subtle part.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { AgentEvent } from '../src/agent/events.js'
import {
  CHUNK_CHARS,
  CHUNK_ROUNDS,
  OPEN_ROUNDS,
  chunkForRow,
  placeholderEvent,
  placeholderRows,
  planChunks,
  promptsTurnRow,
  type HistoryChunk,
} from '../src/dsh-adapter/backend/history-chunks.js'
import { projectHistorySlice } from '../src/channel/history-restore.js'

const digest = (chunk: HistoryChunk): string => `⏸ rounds ${chunk.fromRound}–${chunk.toRound}`

const prompt = (seq: number, text: string, source: 'user' | 'team-message' = 'user'): AgentEvent => ({
  type: 'user.message',
  id: `m${seq}`,
  anchor: String(seq),
  seq,
  time: seq,
  source,
  text,
  blocks: [],
})
const answer = (seq: number, text: string): AgentEvent => ({
  type: 'assistant.message',
  seq,
  anchor: String(seq),
  attemptId: `a${seq}`,
  time: seq,
  blocks: [{ type: 'text', text }],
  canonical: true,
})
const toolCall = (seq: number, turn: number, step: number): AgentEvent => ({
  type: 'tool.call',
  seq,
  turn,
  step,
  callId: `c${seq}`,
  name: 'read_file',
  argsJson: '{"path":"src/index.ts"}',
  time: seq,
})

// ── the cut plan ──────────────────────────────────────────────────────────
assert.deepEqual(planChunks([]), [], 'an empty record plans no chunk')

const noPrompt: AgentEvent[] = [toolCall(0, 1, 1), toolCall(1, 1, 1)]
const lone = planChunks(noPrompt)
assert.equal(lone.length, 1, 'a record with no user message is one chunk')
assert.deepEqual([lone[0]!.start, lone[0]!.end, lone[0]!.rounds], [0, 2, 0])

// 120 rounds with invisible user messages mixed in: every user message opens a
// round, but only prompts and team messages paint a placeholder row.
const entries: AgentEvent[] = []
const prompts: AgentEvent[] = []
let seq = 0
for (let round = 0; round < 120; round += 1) {
  const text = `round ${round} ${'x'.repeat(80)}`
  const event = prompt(seq, text, round % 10 === 3 ? 'team-message' : 'user')
  entries.push(event)
  prompts.push(event)
  seq += 1
  entries.push(answer(seq, `answer ${round} ${'y'.repeat(80)}`))
  seq += 1
  // A goal continuation starts a round (so a long goal run still cuts) but is
  // represented by the digest line alone.
  entries.push(prompt(seq, '', 'injected'))
  seq += 1
}

const chunks = planChunks(entries)
assert.ok(chunks.length >= 2, 'a long record is cut into several chunks')
for (let index = 0; index < chunks.length; index += 1) {
  const chunk = chunks[index]!
  assert.equal(chunk.index, index, 'chunk indices are conversation-ordered')
  assert.equal(chunk.start, index === 0 ? 0 : chunks[index - 1]!.end, 'chunks cover the record contiguously')
  assert.equal(entries[chunk.start]!.type, 'user.message', 'a chunk starts at a round')
  assert.ok(chunk.idBase < 0, 'chunk ids sit below every live row')
  assert.equal(chunk.idBase, -(chunks.length - index) * 1_000_000, 'one id stride per chunk, ordered by index')
  assert.ok(chunk.rounds >= 1 && chunk.rounds <= CHUNK_ROUNDS, 'older chunks stay inside the older budget')
}
assert.equal(chunks.at(-1)!.end, entries.length, 'the newest chunk closes the record')
assert.ok(chunks.at(-1)!.rounds <= OPEN_ROUNDS, 'the newest chunk is the small open budget')
// Deterministic for this record: 240 rounds (a prompt and a goal continuation
// each open one) cut as newest 10, then 50 + 50 + 50 + 50, then the oldest 30.
assert.equal(chunks.length, 6, '240 rounds cut at the older budget make six chunks')

// ── the digest line's numbers ─────────────────────────────────────────────
// A collapsed chunk reports events / tool calls / errors / weight and nothing
// else, so those four must be right: an off-by-one there is a claim the reader
// has no way to check.
const weight = (event: AgentEvent): number => {
  switch (event.type) {
    case 'user.message':
      return event.text.length
    case 'assistant.message':
      return event.blocks.reduce((sum, block) => sum + (block.text?.length ?? 0), 0)
    case 'tool.call':
      return event.argsJson.length
    case 'tool.result':
      return event.text.length
    default:
      return 0
  }
}
for (const chunk of chunks) {
  const range = entries.slice(chunk.start, chunk.end)
  assert.equal(chunk.events, range.length, 'the digest reports its entry count')
  assert.equal(chunk.toolCalls, range.filter(event => event.type === 'tool.call').length, 'and its tool calls')
  assert.equal(chunk.errors, range.filter(event => event.type === 'tool.result' && event.isError === true).length, 'and its failures')
  assert.equal(chunk.chars, range.reduce((sum, event) => sum + weight(event), 0), 'and its text weight')
}

// A round heavier than a whole page still lands alone: a round is taken whole
// or not at all, because a result without its call surfaces as a stray row.
let hugeSeq = 10_000
const huge: AgentEvent[] = []
for (const [text, size] of [['before', 10], ['huge', CHUNK_CHARS + 1], ['after', 10]] as const) {
  huge.push(prompt(hugeSeq, text))
  huge.push(answer(hugeSeq + 1, 'x'.repeat(size)))
  hugeSeq += 2
}
const hugeChunks = planChunks(huge)
assert.equal(hugeChunks.length, 3, 'an oversized round is not merged with its neighbours')
const oversized = hugeChunks.find(chunk => chunk.chars > CHUNK_CHARS)
assert.deepEqual(
  [oversized?.rounds, oversized?.events],
  [1, 2],
  'the oversized round lands alone with both its entries',
)
assert.ok(hugeChunks.every((chunk, index) => chunk.start === (index === 0 ? 0 : hugeChunks[index - 1]!.end)), 'and the tiling still holds')

// ── collapsed rows ────────────────────────────────────────────────────────
for (const chunk of chunks) {
  const rows = placeholderRows(chunk, entries, digest)
  assert.equal(rows[0]!.id, chunk.idBase, 'the digest line owns idBase')
  assert.equal(rows[0]!.kind, 'notice', 'a collapsed chunk is text only')
  assert.equal(rows[0]!.text, digest(chunk), 'the digest line names its rounds')
  let expected = 0
  for (let index = chunk.start; index < chunk.end; index += 1) if (promptsTurnRow(entries[index]!)) expected += 1
  assert.equal(rows.length, expected + 1, 'one placeholder prompt row per prompt event')
  for (let index = 0; index < rows.length; index += 1) {
    assert.equal(rows[index]!.id, chunk.idBase + index, 'placeholder ids are positional')
    assert.equal(rows[index]!.seq, undefined, 'a placeholder carries no seq (no rewind anchor)')
  }
}

// ── which chunk owns a row ────────────────────────────────────────────────
for (const chunk of chunks) {
  assert.equal(chunkForRow(chunks, chunk.idBase), chunk, 'a chunk owns its digest line')
  assert.equal(chunkForRow(chunks, chunk.idBase + 1), chunk, 'and its prompt rows')
  assert.equal(chunkForRow(chunks, chunk.idBase + 999_999), chunk, 'up to its whole id stride')
}
assert.equal(chunkForRow(chunks, 0), undefined, 'live rows belong to no chunk')
assert.equal(chunkForRow(chunks, 27_907), undefined, 'live row ids are never in a chunk range')

// ── placeholder → event → projected row ───────────────────────────────────
const oldest = chunks[0]!
assert.equal(placeholderEvent(oldest, entries, oldest.idBase), undefined, 'the digest line stands for no event')

// A long prompt is capped on the placeholder and restored in full after load:
// that is the point of the reveal (a text-capped digest line is not content).
const longEntryIndex = oldest.end - 1
const longText = 'z'.repeat(5_000)
entries[longEntryIndex] = prompt(entries[longEntryIndex]!.seq, longText)
const rowsAfter = placeholderRows(oldest, entries, digest)
const longRow = rowsAfter.at(-1)!
assert.ok(longRow.text.length <= 601, 'a placeholder prompt line is capped')

const projected = projectHistorySlice(entries.slice(oldest.start, oldest.end), 'preview')
const projectedIds = projected.map((row, index) => ({ row, id: oldest.idBase + 1 + index }))
for (let index = 1; index < rowsAfter.length; index += 1) {
  const rowId = rowsAfter[index]!.id
  const event = placeholderEvent(oldest, entries, rowId)
  assert.ok(event !== undefined, 'every placeholder prompt row stands for an event')
  assert.equal(promptsTurnRow(event), true, 'and that event is a prompt-row event')
  const twin = projectedIds.find(entry => entry.row.seq === event.seq)
  assert.ok(twin !== undefined, `placeholder ${rowId} maps onto a projected row`)
  assert.equal(twin.row.kind, 'user', 'the twin is a prompt row')
  assert.ok(twin.id >= oldest.idBase + 1 && twin.id < oldest.idBase + 1_000_000, 'the twin stays inside the chunk id stride')
}
const longEvent = placeholderEvent(oldest, entries, rowsAfter.at(-1)!.id)!
assert.equal(longEvent.text.length, 5_000, 'the reveal resolves the untruncated event')
assert.equal(projected.find(row => row.seq === longEvent.seq)!.text.length, 5_000, 'and the projected row carries it in full')

// Distinct placeholder rows must map onto distinct projected rows: the rail
// jumps to one turn, not to the first row that shares its text.
const mapped = rowsAfter.slice(1).map((row, index) => projectedIds.find(entry => entry.row.seq === placeholderEvent(oldest, entries, rowsAfter[index + 1]!.id)!.seq)!.id)
assert.equal(new Set(mapped).size, mapped.length, 'each prompt maps onto its own projected row')

// ── the click path ────────────────────────────────────────────────────────
// The rail's reveal must ask the channel to load the owning region instead of
// expanding the fold over the whole record.
const chat = readFileSync(new URL('../src/screens/Chat.tsx', import.meta.url), 'utf8')
assert.match(
  chat,
  /const revealAndSeekRow = \(rowId: number\): void => \{[\s\S]{0,500}?channel\.revealRow\(rowId\)[\s\S]{0,300}?seekRow\(revealed === 0 \? rowId : revealed\)/u,
  'a rail reveal loads the row\'s owning region and seeks its loaded twin',
)

// …and the region it loads is one chunk: expanding every older chunk is the
// freeze this replaced.
const extensions = readFileSync(new URL('../src/dsh-adapter/channel/extensions.ts', import.meta.url), 'utf8')
const reveal = /const revealChunkRow = \([\s\S]*?\n  \}\n/u.exec(extensions)?.[0] ?? ''
assert.match(reveal, /materializeChunk\(chunk\)/u, 'a reveal projects the one owning chunk')
assert.doesNotMatch(reveal, /loadOlder|planChunks\(|state\.rows = /u, 'and never expands or rebuilds the record')

console.log(`verify-history-chunks OK (${chunks.length} chunks over ${entries.length} events, ${prompts.length} prompts)`)
