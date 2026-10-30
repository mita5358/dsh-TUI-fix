/**
 * `foldBack` (the DSH backend's "load earlier") restores folded rows from the
 * durable session log. It cleared `folded` but never set `restored`, and
 * `foldRows` exempts a row from the next pass on `row.folded || row.restored`
 * (`src/dsh-adapter/channel/transcript.ts`, the `if (row.folded || row.restored)
 * continue` guard).
 *
 * On the DSH backend that guard is not academic: the channel folds on every
 * `emit()`/`wake()`, i.e. once per streaming frame. A row that "load earlier"
 * had just restored was therefore folded again by the very next frame — the
 * press appeared to do nothing, and the full text it had just read back out of
 * the session log was dropped almost immediately. The Claude path already
 * survives this because its history restore sets the same flag
 * (`src/channel/history-restore.ts`); this file pins DSH to that behaviour.
 *
 * Run: node --import tsx/esm scripts/verify-dsh-fold-back-restored.ts
 */
const { foldBack, foldRows, MAX_ROWS } = await import('../src/dsh-adapter/channel/transcript.js')
type SessionEvent = import('@deepseek-ai/dsh-session').SessionEvent
type ChatRow = import('../src/dsh-adapter/channel/types.js').ChatRow

let passed = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) {
    console.error(`\n  ✗ ${label}`, detail === undefined ? '' : detail)
    process.exit(1)
  }
  passed += 1
  console.log(`  ✓ ${label}`)
}

let nextId = 1
const textRow = (seq: number, text = 'full text the row shows once restored'): ChatRow => ({
  id: nextId++,
  kind: 'assistant',
  text,
  folded: true,
  seq,
})
const toolRow = (seq: number, callId: string): ChatRow => ({
  id: nextId++,
  kind: 'tool',
  text: 'preview',
  folded: true,
  seq,
  tool: { callId, name: 'read_file', argsText: '{}', status: 'ok' } as ChatRow['tool'],
})
const message = (seq: number, text = 'restored assistant text'): SessionEvent =>
  ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }) as unknown as SessionEvent
const call = (seq: number): SessionEvent =>
  ({ seq, type: 'tool/call', data: { name: 'read_file', arguments: { path: 'a.ts' } } }) as unknown as SessionEvent

// ── the flag itself ──────────────────────────────────────────────────────────

{
  const rows = [textRow(1)]
  foldBack(rows, [message(1)])
  check('a restored text row is marked `restored`', rows[0]!.restored === true, { row: rows[0] })
}

{
  const rows = [toolRow(2, 'c1')]
  foldBack(rows, [call(2)])
  check('a restored tool row is marked `restored`', rows[0]!.restored === true, { row: rows[0] })
}

{
  const rows = [textRow(50)]
  foldBack(rows, [message(1)])
  check('a row the log cannot answer is NOT marked `restored`', rows[0]!.restored !== true, { row: rows[0] })
}

// ── the regression: the next fold pass must leave it alone ───────────────────
//
// This is the actual bug. Build a window that is over the cap, restore it the
// way a press does, then run the fold pass the next streaming frame runs.

{
  const rows: ChatRow[] = []
  const events: SessionEvent[] = []
  for (let i = 0; i < MAX_ROWS + 200; i++) {
    rows.push(textRow(i + 1, `full text ${i + 1}`))
    events.push(message(i + 1, `full text ${i + 1}`))
  }
  const restored = foldBack(rows, events)
  check('the press restores the folded tail', restored > 0, { restored })

  const keptText = rows.map(row => row.text)
  const foldedAgain = foldRows(rows, MAX_ROWS)
  check('the next fold pass folds nothing back', foldedAgain === 0, { foldedAgain })
  check(
    'every restored row keeps its full text',
    rows.every((row, i) => row.text === keptText[i] && row.folded === false),
    { changed: rows.filter((row, i) => row.text !== keptText[i]).length },
  )
}

// …and the guard really is what stops it: without the flag, the same pass
// folds everything back. Asserting this keeps the test honest — if `foldRows`
// ever stops honouring `restored`, the check above would pass vacuously.
{
  const rows: ChatRow[] = []
  const events: SessionEvent[] = []
  for (let i = 0; i < MAX_ROWS + 200; i++) {
    rows.push(textRow(i + 1, `full text ${i + 1}`))
    events.push(message(i + 1, `full text ${i + 1}`))
  }
  foldBack(rows, events)
  for (const row of rows) row.restored = false // pretend the flag was never set
  check('without the flag the same pass folds the window back', foldRows(rows, MAX_ROWS) > 0)
}

// ── the exemption must not disable folding ──────────────────────────────────
//
// Folding acts on the rows BELOW the fold line (the oldest `excess` rows); the
// exemption is per row, not a switch. A session that keeps streaming after a
// restore must still fold the rows that reach the fold line, or a long session
// would grow without bound. Push enough new rows that some of them fall below
// the line, and check exactly those fold while the restored ones do not.

{
  const rows: ChatRow[] = []
  const events: SessionEvent[] = []
  for (let i = 0; i < MAX_ROWS + 200; i++) {
    rows.push(textRow(i + 1, `full text ${i + 1}`))
    events.push(message(i + 1, `full text ${i + 1}`))
  }
  foldBack(rows, events)
  const restoredCount = rows.length
  for (let i = 0; i < MAX_ROWS + 200; i++) {
    rows.push({ id: nextId++, kind: 'assistant', text: `streamed ${i}`, folded: false, seq: restoredCount + i + 1 })
  }
  const excess = rows.length - MAX_ROWS
  const belowLine = rows.slice(0, excess)
  const freshBelowLine = belowLine.filter(row => row.restored !== true)
  const foldedNow = foldRows(rows, MAX_ROWS)
  check(
    'rows reaching the fold line after a restore still fold',
    freshBelowLine.length > 0 && foldedNow === freshBelowLine.length,
    { freshBelowLine: freshBelowLine.length, foldedNow },
  )
  check(
    '…while every restored row below the line stays intact',
    belowLine.filter(row => row.restored === true).every(row => row.folded === false),
  )
}

console.log(`\nverify-dsh-fold-back-restored OK (${passed} checks)`)
