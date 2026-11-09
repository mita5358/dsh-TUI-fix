/**
 * Chunked history: the cut plan, the collapsed section row, and the id range a
 * load-on-sight / rail reveal depends on (`ChannelUi.revealRow`, implemented by
 * the DSH extension's `revealChunkRow`).
 *
 * The regressions this guards: (1) a reveal used to expand the WHOLE record
 * (`showAllMessages`, a 27,907-row relayout, 5.6 GB RSS before the process was
 * killed) — it must project only the owning chunk; (2) a collapsed chunk used
 * to fake one prompt row per human prompt, which made the transcript read as if
 * every old turn were missing its answer — a collapsed chunk is now exactly one
 * section line and nothing else.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { AgentEvent, AgentEventOf } from '../src/agent/events.js'
import {
  CHUNK_CHARS,
  CHUNK_ROUNDS,
  OPEN_ROUNDS,
  chunkForRow,
  placeholderRows,
  planChunks,
  type HistoryChunk,
} from '../src/dsh-adapter/backend/history-chunks.js'
import { projectHistorySlice } from '../src/channel/history-restore.js'

const digest = (chunk: HistoryChunk): string => `⏸ rounds ${chunk.fromRound}–${chunk.toRound}`

const prompt = (seq: number, text: string, source: AgentEventOf<'user.message'>['source'] = 'user'): AgentEventOf<'user.message'> => ({
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
// One row per unloaded chunk: the section line, flagged so the transcript
// projects the chunk on sight. No prompt stand-ins and no projected content —
// a collapsed chunk must never look like a conversation whose answers are gone.
for (const chunk of chunks) {
  const rows = placeholderRows(chunk, digest, entries)
  assert.equal(rows.length, 1, 'an unloaded chunk contributes exactly one row')
  const row = rows[0]!
  assert.equal(row.id, chunk.idBase, 'the section line owns idBase')
  assert.equal(row.kind, 'notice', 'a collapsed chunk is text only')
  assert.equal(row.text, digest(chunk), 'the section line names its rounds')
  assert.equal(row.collapsed, true, 'and is flagged as load-on-sight')
  assert.equal(row.restored, true, 'and is exempt from the fold pass')
  assert.equal(row.seq, undefined, 'a section line carries no seq (no rewind anchor)')
  assert.equal(row.anchor, undefined, 'and no anchor: the log anchor arrives with the load')
}

// The bug this replaced: a collapsed chunk must not claim to be user rows.
for (const chunk of chunks) {
  assert.deepEqual(
    placeholderRows(chunk, digest, entries).filter(row => row.kind === 'user'),
    [],
    'no prompt stand-in rows remain in the collapsed form',
  )
}

// ── navigation is complete without painting fake prompt rows ─────────────
const indexed = chunks.flatMap(chunk => placeholderRows(chunk, digest, entries)[0]!.collapsedTurns ?? [])
const humanRows = projectHistorySlice(entries, 'preview').filter(row => row.kind === 'user' && row.label !== 'team-message')
assert.deepEqual(indexed.map(turn => turn.seq), humanRows.map(row => row.seq), 'the index covers every real human prompt in record order')
assert.equal(new Set(indexed.map(turn => turn.id)).size, indexed.length, 'handles are unique across all chunks')
assert.ok(indexed.every(turn => turn.id < chunks[0]!.idBase), 'virtual handles never collide with real chunk or live rows')
assert.ok(indexed.every(turn => chunkForRow(chunks, turn.id) === undefined), 'a virtual handle cannot accidentally reveal another chunk')
for (const chunk of chunks) {
  const meta = placeholderRows(chunk, digest, entries)[0]!.collapsedTurns ?? []
  const real = projectHistorySlice(entries.slice(chunk.start, chunk.end), 'preview')
  for (const turn of meta) {
    const row = real.find(row => row.kind === 'user' && row.label !== 'team-message' && row.seq === turn.seq)
    assert.equal(row?.text, turn.text, 'every handle resolves to the exact projected prompt by seq')
  }
}
// Empty inputs and background sources do not create human ticks. Whitespace
// and image-only human prompts DO, exactly like the shared projector.
const edgeEntries: AgentEvent[] = [
  prompt(20_000, ''),
  prompt(20_001, '   '),
  { ...prompt(20_002, ''), images: [{ id: 'image', width: 1, height: 1, read: async () => new Uint8Array() }] },
  prompt(20_003, 'peer', 'team-message'),
  prompt(20_004, 'goal', 'injected'),
  prompt(20_005, 'checkpoint', 'compaction'),
  prompt(20_006, 'command output', 'command-output'),
]
const edgeChunk = planChunks(edgeEntries)[0]!
const edgeIndex = placeholderRows(edgeChunk, digest, edgeEntries)[0]!.collapsedTurns!
assert.deepEqual(edgeIndex.map(turn => turn.seq), [20_001, 20_002], 'the index uses the projector visibility/source predicate')
assert.deepEqual(edgeIndex.map(turn => turn.imageCount), [0, 1], 'image-only prompts retain their preview count')

// ── which chunk owns a row ────────────────────────────────────────────────
for (const chunk of chunks) {
  assert.equal(chunkForRow(chunks, chunk.idBase), chunk, 'a chunk owns its section line')
  assert.equal(chunkForRow(chunks, chunk.idBase + 1), chunk, 'and the ids its loaded rows will take')
  assert.equal(chunkForRow(chunks, chunk.idBase + 999_999), chunk, 'up to its whole id stride')
}
assert.equal(chunkForRow(chunks, 0), undefined, 'live rows belong to no chunk')
assert.equal(chunkForRow(chunks, 27_907), undefined, 'live row ids are never in a chunk range')

// ── load-on-sight target ──────────────────────────────────────────────────
// The section line's id is the reveal handle: it survives materialization
// (`chunkRows` also starts at idBase), so the transcript can project the chunk
// and keep the reader anchored on the same line. A loaded chunk's projected
// rows must cover real answers, which is what makes the load worth doing.
const oldest = chunks[0]!
const projected = projectHistorySlice(entries.slice(oldest.start, oldest.end), 'preview')
assert.ok(projected.some(row => row.kind === 'assistant'), 'a loaded chunk contains model output')
assert.ok(projected.some(row => row.kind === 'user'), 'and the prompts it answered')
assert.ok(projected.every(row => row.id >= 0), 'projection assigns live ids; the chunk re-bases them off idBase')
for (let index = 0; index < projected.length; index += 1) {
  const id = oldest.idBase + 1 + index
  assert.ok(id < oldest.idBase + 1_000_000, 'every loaded row stays inside the chunk id stride')
}
