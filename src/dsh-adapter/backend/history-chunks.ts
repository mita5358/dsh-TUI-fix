/**
 * Titan-session chunking — open a very long conversation without projecting
 * its whole record.
 *
 * The replay cost of a long session is the per-event fold over hundreds of MB
 * of message and tool text (measured on an 89k-event / 447 MB record: 1,766 ms
 * to 27,907 rows), never the row count — rendering is already bounded by
 * `MAX_ROWS` / `RENDERED_ROW_CAP`, and dropping the rows saved 34 ms. So the
 * record is cut into round-aligned chunks and only the NEWEST chunk is
 * projected for the first paint. Every older chunk contributes one digest row
 * (kind `notice`: a plain text report, no tool cards, no terminal output, no
 * command rows) plus one plain prompt row per human prompt it holds.
 *
 * Those prompt rows are what keeps the timeline rail complete: it indexes
 * `kind: 'user'` rows, so a collapsed chunk still shows its ticks and a tick
 * jumps to its prompt (text capped, see `PLACEHOLDER_TEXT_LIMIT`). Loading the
 * chunk replaces its placeholder rows in place (see `placeholderRows` and the
 * adapter's `loadOlderChunk`), which is what "load earlier" does.
 *
 * Cut rule: only at a `user.message`, i.e. at a round's first event, whatever
 * its source. A round is never split — a tool result without its call would
 * surface as a stray row — so one giant round simply becomes one oversized
 * chunk.
 *
 * Pure: no I/O, no vendor imports, no projection. The adapter owns the
 * localized digest text.
 */

import type { ChatRow } from '../../adapter/ports/channel-view.js'
import type { AgentEvent } from '../../agent/events.js'

/** Rounds in the newest chunk: small on purpose. It is the only chunk
 *  projected before the transcript opens, so its size is the open latency. */
export const OPEN_ROUNDS = 10

/** Characters in the newest chunk: same reason, for text-heavy rounds. */
export const OPEN_CHARS = 200_000

/** Rounds per older chunk: they only load on demand, and a bigger page means
 *  fewer "load earlier" presses. 50 rounds of this record project in ~7 ms. */
export const CHUNK_ROUNDS = 50

/** Characters per older chunk: closes a chunk before the round that would
 *  overflow it. A heavier round still lands alone, never split. */
export const CHUNK_CHARS = 1000000

/** Row-id range reserved per chunk. Chunk ids are negative (below every live
 *  row) and ordered by chunk index, so a chunk loaded later still sorts before
 *  the chunks after it. One million ids per chunk is far above `MAX_ROWS`. */
const ID_STRIDE = 1_000_000

/** Cap on a placeholder prompt row's text: a resumed session must not pay to
 *  re-render a 500 KB paste it has not opened. Loading the chunk restores the
 *  full text from the record. */
const PLACEHOLDER_TEXT_LIMIT = 600

/** One contiguous, turn-aligned slice of a translated record. */
export interface HistoryChunk {
  /** Position in conversation order; 0 is the oldest. */
  readonly index: number
  /** Entry range `[start, end)` in the translated record. */
  readonly start: number
  readonly end: number
  /** Rounds in the chunk (≥ 1): a human prompt, a goal continuation or a
   *  compaction boundary each start one. */
  readonly rounds: number
  /** Ordinal of its first and last round (1-based over the record): the report
   *  line's "rounds N–M". */
  readonly fromRound: number
  readonly toRound: number
  /** Entries, tool calls and failed tool results in the range. */
  readonly events: number
  readonly toolCalls: number
  readonly errors: number
  /** Characters of prompt/answer/tool text: the chunk's replay weight. */
  readonly chars: number
  /** First row id of the chunk's rows (negative, ordered by `index`). */
  readonly idBase: number
}

/** Text weight of one event, without materializing any joined text. */
function textChars(event: AgentEvent): number {
  switch (event.type) {
    case 'user.message':
      return event.text.length
    case 'assistant.message': {
      let chars = 0
      for (const block of event.blocks) chars += block.text?.length ?? 0
      return chars
    }
    case 'tool.call':
      return event.argsJson.length
    case 'tool.result':
      return event.text.length
    case 'assistant.delta':
      return event.delta.kind === 'text' || event.delta.kind === 'reasoning' ? event.delta.text.length : 0
    default:
      return 0
  }
}

/** True on the event that opens a round (and therefore a chunk): every user
 *  message does, whatever its source — a human prompt, a goal continuation
 *  (`injected`) or a compaction boundary. Cutting at the invisible ones keeps
 *  a long goal-driven run from collapsing into one huge chunk, at no cost to
 *  the transcript: a collapsed chunk paints only its digest and its prompts. */
function startsRound(event: AgentEvent): boolean {
  return event.type === 'user.message'
}

/**
 * Cut a translated record into round-aligned chunks. Returns one chunk for an
 * empty record's caller to skip, and one chunk holding everything when the
 * record has no user message at all (a seeded/forked leaf, an aborted boot).
 */
export function planChunks(entries: readonly AgentEvent[]): HistoryChunk[] {
  if (entries.length === 0) return []
  // Pass 1: where rounds start, and how heavy each one is, so grouping only
  // needs per-round numbers.
  const starts: number[] = []
  const chars: number[] = []
  let last = -1
  for (let index = 0; index < entries.length; index += 1) {
    const event = entries[index]!
    if (startsRound(event)) {
      starts.push(index)
      chars.push(0)
      last += 1
    }
    if (last >= 0) chars[last]! += textChars(event)
  }
  if (starts.length === 0) {
    return [{
      index: 0,
      start: 0,
      end: entries.length,
      ...measure(entries, 0, entries.length),
      rounds: 0,
      fromRound: 0,
      toRound: 0,
      idBase: -ID_STRIDE,
    }]
  }
  // Pass 2: group backwards, newest round first, so the tail gets the small
  // OPEN_* budget and every older chunk the CHUNK_* one. A round is taken
  // whole or not at all: a heavier-than-budget round lands alone.
  const groups: { first: number; last: number }[] = []
  let tail = starts.length - 1
  while (tail >= 0) {
    const opens = groups.length === 0
    const maxRounds = opens ? OPEN_ROUNDS : CHUNK_ROUNDS
    const maxChars = opens ? OPEN_CHARS : CHUNK_CHARS
    let first = tail
    let weight = chars[tail]!
    while (first > 0 && tail - first + 1 < maxRounds && weight + chars[first - 1]! <= maxChars) {
      first -= 1
      weight += chars[first]!
    }
    groups.push({ first, last: tail })
    tail = first - 1
  }
  groups.reverse()
  const total = groups.length
  return groups.map((group, index) => {
    const start = group.first === 0 ? 0 : starts[group.first]!
    const end = group.last + 1 < starts.length ? starts[group.last + 1]! : entries.length
    return {
      index,
      start,
      end,
      ...measure(entries, start, end),
      rounds: group.last - group.first + 1,
      fromRound: group.first + 1,
      toRound: group.last + 1,
      idBase: -(total - index) * ID_STRIDE,
    }
  })
}

/** Counts of an entry range: what a collapsed chunk reports, and its weight. */
function measure(
  entries: readonly AgentEvent[],
  start: number,
  end: number,
): Pick<HistoryChunk, 'events' | 'toolCalls' | 'errors' | 'chars'> {
  let toolCalls = 0
  let errors = 0
  let chars = 0
  for (let index = start; index < end; index += 1) {
    const event = entries[index]!
    chars += textChars(event)
    if (event.type === 'tool.call') toolCalls += 1
    if (event.type === 'tool.result' && event.isError) errors += 1
  }
  return { events: end - start, toolCalls, errors, chars }
}

/** True on a user message that paints a prompt row: a human prompt or a team
 *  message. A compaction notice, a replay of terminal output or a goal
 *  continuation does not — it is represented by the digest line alone. */
function promptRow(event: AgentEvent): boolean {
  if (event.type !== 'user.message') return false
  if (event.source === 'team-message') return true
  return event.source === 'user' && (event.text !== '' || (event.images?.length ?? 0) > 0)
}

/** Cap a placeholder prompt line: the record still holds the full text. */
function placeholderText(text: string): string {
  if (text.length <= PLACEHOLDER_TEXT_LIMIT) return text
  return `${text.slice(0, PLACEHOLDER_TEXT_LIMIT)}…`
}

/**
 * The rows an UNLOADED chunk contributes: its digest row, then one plain
 * prompt row per turn. No tool cards, no terminal output, no command rows —
 * a collapsed chunk is text only. Every row is `restored` so a later fold pass
 * never truncates the digest, and carries no `seq`/`anchor`: these rows are
 * not derived from a single log event, and the rewind anchor must stay absent
 * until the chunk is actually loaded.
 */
export function placeholderRows(
  chunk: HistoryChunk,
  entries: readonly AgentEvent[],
  digest: (chunk: HistoryChunk) => string,
): ChatRow[] {
  const rows: ChatRow[] = [{ id: chunk.idBase, kind: 'notice', text: digest(chunk), restored: true }]
  for (let index = chunk.start; index < chunk.end; index += 1) {
    const event = entries[index]!
    if (event.type !== 'user.message') continue
    const images = event.images === undefined ? {} : { images: event.images }
    if (event.source === 'team-message') {
      rows.push({
        id: chunk.idBase + rows.length,
        kind: 'user',
        label: 'team-message',
        text: placeholderText(event.text),
        ...(event.sender === undefined ? {} : { sender: event.sender }),
        ...images,
        restored: true,
      })
      continue
    }
    if (!promptRow(event)) continue
    rows.push({ id: chunk.idBase + rows.length, kind: 'user', text: placeholderText(event.text), ...images, restored: true })
  }
  return rows
}
