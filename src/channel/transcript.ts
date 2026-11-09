/** Backend-neutral transcript limits and text helpers shared by the projector,
 *  the fold pass and the local-output paths. */

export const ARGS_PREVIEW_LIMIT = 160

export const RESULT_PREVIEW_LIMIT = 240

/** Local `!`-command output cap (mirrors the result preview limit). */
export const LOCAL_OUTPUT_LIMIT = 240

/**
 * In-memory transcript window cap. Older rows beyond this count are folded:
 * their full-text fields (assistant/reasoning text, tool args/results) are
 * dropped and only the preview/status metadata kept. This limits the full
 * text retained by this pass, not the number of rows or total process memory:
 * previews, raw session data and indices may still grow. The session log
 * remains the source of truth (`/export` reads it, `/resume` replays it); the
 * folded row keeps its kind/id so scrolling and selection stay stable.
 */
export const MAX_ROWS = 600

export function preview(text: string, limit: number): string {
  // Read a bounded prefix only. Tool results can be megabytes; flattening the
  // whole string (one regex pass plus a full-size allocation) just to cut
  // `limit` characters back out dominated chunk reveal, at ~30 ms per big
  // result. The window doubles when whitespace swallowed the whole prefix, so
  // an indented/empty head still finds content instead of returning nothing.
  let window = Math.min(text.length, Math.max(limit * 4, 256))
  for (;;) {
    const flat = text.slice(0, window).replace(/\s+/g, ' ').trim()
    if (flat.length > limit) return `${flat.slice(0, limit)}…`
    if (window >= text.length) return flat
    window = Math.min(text.length, window * 2)
  }
}

/**
 * One report line that keeps its shape: blank rows stay blank and leading
 * indentation survives; a stray newline still cannot become a second row.
 */
export function previewIndented(text: string, limit: number): string {
  const line = text.replace(/[\r\n]+/gu, ' ').replace(/\s+$/u, '')
  // A truly empty Text node measures as zero height; one no-break space keeps
  // the blank row the report asked for without painting anything.
  if (line === '') return '\u00a0'
  return line.length <= limit ? line : `${line.slice(0, limit)}…`
}

/**
 * Keep local rows inside the transcript budget: drop the oldest `local` block
 * (its title plus its `local-output` lines) until the incoming report fits.
 * A run of headerless `local-output` rows (a `!!` replay with no `local`
 * companion) counts as one block — nothing marks a boundary inside it.
 * Local rows cannot be restored from backend history, so nothing else bounds
 * them — `foldRows` deliberately leaves them alone. Shared by `pushLocal`
 * (channel-side reports) and the projector (backend command reports).
 */
export function trimLocalRows(rows: { kind: string }[], nextLines: number): void {
  let count = rows.reduce((sum, row) => sum + Number(row.kind === 'local' || row.kind === 'local-output'), nextLines)
  for (let i = 0; count > MAX_ROWS && i < rows.length;) {
    if (rows[i]!.kind !== 'local' && rows[i]!.kind !== 'local-output') { i++; continue }
    let end = i + 1
    while (rows[end]?.kind === 'local-output') end++
    count -= end - i
    rows.splice(i, end - i)
  }
}
