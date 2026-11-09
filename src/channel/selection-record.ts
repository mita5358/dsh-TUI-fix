/**
 * Replay of the IDE-selection indicator from durable user-message content.
 * The submit path (`dsh-adapter/channel/ide-selection.ts`) appends an
 * `<attached-file path="…" selection count="N">` text block the channel itself
 * builds; parsing it back is channel-format knowledge, not backend knowledge,
 * so it lives beside the shared projector that needs it.
 */
import type { SelectionAttachment } from '../adapter/ports/channel-view.js'

/**
 * Derive the transcript indicator from the durable user-message content:
 * the `<attached-file path="…" selection count="N">` block the submit path
 * appended is part of the persisted event, so a replayed session can rebuild
 * the "Selected N lines from <file>" line even though the in-memory
 * message-id → attachment map starts empty. The indicator must not depend
 * on process-local state.
 */
export function replaySelectionAttachment(
  content: readonly unknown[] | undefined,
): SelectionAttachment | undefined {
  if (content === undefined) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as { type?: unknown; text?: unknown }).text
    if ((block as { type?: unknown }).type !== 'text' || typeof text !== 'string') continue
    const opened = /^<attached-file path="([^"]+)" selection(?: count="(\d+)")?>\n/.exec(text)
    if (opened === null) continue
    // `count` is authoritative when present (the builder always writes it),
    // so current records need no explicit body scan or split.
    const counted = opened[2] === undefined ? undefined : Number(opened[2])
    let lines = counted
    if (lines === undefined) {
      const start = opened[0].length
      let end = text.length
      const close = '</attached-file>'
      if (end - start >= close.length && text.endsWith(close, end)) end -= close.length
      // The closing tag's preceding newline is not a body line.
      if (end > start && text.charCodeAt(end - 1) === 10) end -= 1
      lines = 1
      for (let pos = text.indexOf('\n', start); pos !== -1 && pos < end; pos = text.indexOf('\n', pos + 1)) lines += 1
      // Preserve the legacy heuristic for records predating `count`.
      const marker = '\n[… truncated]'
      if (end - start >= marker.length && text.endsWith(marker, end)) lines -= 1
    }
    return {
      lines,
      // Reverse escapeSnippetAttr so the replayed indicator shows the path
      // exactly as the live one did (`&` first so entities are not re-baked).
      path: opened[1]!
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&'),
    }
  }
  return undefined
}
