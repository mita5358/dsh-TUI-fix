import { t } from '../i18n.js'
import { primaryComboString } from './keymap.js'

/**
 * Per-line character budget for transcript text.
 *
 * A single source line longer than this is clipped BEFORE it reaches the
 * layout engine. Wrapping is what costs: one minified-JS line, a 300k-char
 * pasted log line, or a file written through a tool call turns into
 * thousands of visual rows, and the per-frame wrap + measure over that text
 * (not the row count) is what stalls the transcript. Clipping at the source
 * keeps the rendered line count — and therefore the layout work — bounded
 * no matter what the model, the user, or a tool pastes in.
 *
 * 1000 characters is roughly ten terminal rows at a common width: long
 * enough that ordinary prose, commands and URLs never notice, short enough
 * that the pathological single line cannot dominate a frame. The exact
 * threshold is a display choice, not a contract — `Ctrl+O` (global
 * transcript expansion) always paints the raw text.
 */
export const LONG_LINE_MAX_CHARS = 1000

/** Tokens the transcript turns into hyperlinks: Markdown link targets,
 *  bare URLs, `dsh-file:` paths, issue references and file paths. Clipping
 *  inside one would paint a link whose destination differs from the source
 *  text (an autolinked truncated URL), so such a partial token is dropped
 *  instead of being shown. */
const LINK_TOKEN =
  /^(?:\[[^\]\n]*\]\(|[a-z][a-z0-9+.-]*:\/\/|(?:dsh-file|file):|\.{0,2}\/|~\/|[\w.-]+\/[\w.-]+#\d+|[\w.-]+\/[\w.-]+\.[a-z0-9]{1,8}(?:[?#][^\s]*)?)/i

/** Fence delimiter at the start of a line (` ``` ` / `~~~`, also inside a
 *  blockquote or list quote prefix). */
const FENCE_OPEN = /^(?: {0,3}(?:> ?)*)(`{3,}|~{3,})/

const isWhitespace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 13

/**
 * Start index of the token the clip would split when that token is a link
 * target; the unmodified `cut` otherwise. The clip is only unsafe when it
 * falls strictly inside a token (neither side is whitespace).
 */
function safeClipEnd(text: string, lineStart: number, cut: number, lineEnd: number): number {
  if (cut <= lineStart || cut >= lineEnd) return cut
  if (isWhitespace(text.charCodeAt(cut - 1)) || isWhitespace(text.charCodeAt(cut))) return cut
  let tokenStart = cut
  while (tokenStart > lineStart && !isWhitespace(text.charCodeAt(tokenStart - 1))) tokenStart--
  let tokenEnd = cut
  while (tokenEnd < lineEnd && !isWhitespace(text.charCodeAt(tokenEnd))) tokenEnd++
  return LINK_TOKEN.test(text.slice(tokenStart, tokenEnd)) ? tokenStart : cut
}

export type LongLineFold = {
  /** Text to render. Identity-equal to the input when nothing was folded. */
  readonly text: string
  /** Characters elided across every folded line (0 → nothing folded). */
  readonly hiddenChars: number
  /** Number of lines that were clipped. */
  readonly foldedLines: number
}

/** Compact count for the fold marker: exact below 10k, `12.3k`/`1.2m`
 *  above (the status bar's own token/char presentation). */
function formatCount(value: number): string {
  if (value < 10_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 100_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

/**
 * Clip every line of `text` longer than `max` characters, appending an
 * inline localized fold marker (`long-line-folded`) to the clipped line.
 *
 * Lines inside a fenced code block are never clipped: the fence has its own
 * fold/expand gesture, and truncating its body would hand Markdown a broken
 * block (and the expanded view a truncated copy of the user's code).
 * Line boundaries are preserved (never re-flowed or merged), but clipping
 * raw text can split Markdown links, ANSI sequences or code fences. Callers
 * must not assume the result retains the original formatting or link targets.
 * The caller decides WHEN to fold; the no-fold path does not allocate line
 * slices.
 */
export function foldLongLines(text: string, max: number = LONG_LINE_MAX_CHARS): LongLineFold {
  if (text === '' || max <= 0) return { text, hiddenChars: 0, foldedLines: 0 }
  // Common case (an ordinary message): no line can exceed the budget, so the
  // whole scan is skipped. This is the path every short row takes.
  if (text.length <= max) return { text, hiddenChars: 0, foldedLines: 0 }

  let out: string[] | undefined
  let lineStart = 0
  let hiddenChars = 0
  let foldedLines = 0
  /** Open fence (` ``` ` vs `~~~`) and its delimiter length, if any. */
  let fence: { char: string; length: number } | undefined

  for (;;) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const delimiter = FENCE_OPEN.exec(text.slice(lineStart, Math.min(lineEnd, lineStart + 64)))
    if (delimiter !== null) {
      const marker = delimiter[1]!
      const char = marker[0]!
      if (fence === undefined) fence = { char, length: marker.length }
      else if (fence.char === char && marker.length >= fence.length) fence = undefined
    }
    const folded = fence === undefined && lineEnd - lineStart > max

    if (folded) {
      // First fold: everything before this line is untouched, so it is
      // copied over in one slice and every later line is appended in order.
      if (out === undefined) {
        out = []
        if (lineStart > 0) out.push(text.slice(0, lineStart))
      }
    }
    if (out !== undefined) {
      if (folded) {
        let end = lineStart + max
        // Never split a surrogate pair: an astral character (emoji, rare CJK)
        // is two UTF-16 code units, and half of one renders as U+FFFD.
        const lead = text.charCodeAt(end - 1)
        const trail = text.charCodeAt(end)
        if (lead >= 0xD800 && lead <= 0xDBFF && trail >= 0xDC00 && trail <= 0xDFFF) end--
        // Never paint a truncated hyperlink target (see LINK_TOKEN).
        end = safeClipEnd(text, lineStart, end, lineEnd)
        const hidden = lineEnd - end
        hiddenChars += hidden
        foldedLines++
        out.push(text.slice(lineStart, end))
        out.push(` ${t('long-line-folded', { n: formatCount(hidden), key: primaryComboString('transcript') })}`)
      } else {
        out.push(text.slice(lineStart, lineEnd))
      }
      if (newline !== -1) out.push('\n')
    }
    if (newline === -1) break
    lineStart = newline + 1
  }

  if (out === undefined) return { text, hiddenChars: 0, foldedLines: 0 }
  return { text: out.join(''), hiddenChars, foldedLines }
}
