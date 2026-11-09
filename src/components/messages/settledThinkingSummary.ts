import { getGraphemeSegmenter } from '../../utils/intl.js'
import { stringWidth } from '../../ink/stringWidth.js'

// Bounded independently of the source size, including pathological clusters
// and unterminated terminal strings. The preview copies, never slices, input.
const RAW_LIMIT = 4096
const CLEAN_LIMIT = 512
const OUTPUT_LIMIT = 160

/** Return the sanitized beginning of the first nonblank line, plus an ellipsis. */
export function settledThinkingHead(input: string): string {
  let state: 'ground' | 'string' | 'csi' | 'escape' | 'escape-intermediate' = 'ground'
  let osc = false
  let stringEscape = false
  let pos = 0
  let clean = ''
  let pendingSpace = false
  let cut = false
  let lineEnded = false

  while (pos < input.length && pos < RAW_LIMIT) {
    const n = input.charCodeAt(pos++)
    if (state === 'string') {
      if (n === 0x9c || (stringEscape && n === 0x5c) || (osc && n === 0x07)) {
        state = 'ground'
        stringEscape = false
      } else {
        stringEscape = n === 0x1b
      }
      continue
    }
    if (state === 'csi') {
      // CR/LF are executable C0 controls even inside a CSI.
      if (n === 0x0a || n === 0x0d) { state = 'ground'; lineEnded = true; break }
      if (n >= 0x40 && n <= 0x7e) state = 'ground'
      else if (!((n >= 0x20 && n <= 0x3f) || (n < 0x20 && n !== 0x1b))) break
      continue
    }
    if (state === 'escape') {
      if (n === 0x5b) state = 'csi'
      else if (n === 0x5d || n === 0x50 || n === 0x58 || n === 0x5e || n === 0x5f) {
        state = 'string'
        osc = n === 0x5d
        stringEscape = false
      } else if (n >= 0x20 && n <= 0x2f) state = 'escape-intermediate'
      else if (n >= 0x30 && n <= 0x7e) state = 'ground'
      else break
      continue
    }
    if (state === 'escape-intermediate') {
      if (n >= 0x30 && n <= 0x7e) state = 'ground'
      else if (!(n >= 0x20 && n <= 0x2f)) break
      continue
    }
    if (n === 0x1b) { state = 'escape'; continue }
    if (n === 0x9b) { state = 'csi'; continue }
    if (n === 0x90 || n === 0x98 || n === 0x9d || n === 0x9e || n === 0x9f) {
      state = 'string'
      osc = n === 0x9d
      stringEscape = false
      continue
    }
    // Skip blank leading body lines; never cross a line after content begins.
    // Newlines inside OSC/DCS were already consumed as string payload.
    if (n === 0x0a || n === 0x0d || n === 0x2028 || n === 0x2029) {
      if (clean !== '') { lineEnded = true; break }
      continue
    }
    if (n === 0x20 || n === 0x09 || (n > 0x9f && String.fromCharCode(n).trim() === '')) {
      if (clean) pendingSpace = true
      continue
    }
    if (n < 0x20 || (n >= 0x7f && n <= 0x9f)) continue
    let out: string
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = pos < input.length && pos < RAW_LIMIT ? input.charCodeAt(pos) : -1
      if (next >= 0xdc00 && next <= 0xdfff) { out = String.fromCharCode(n, next); pos++ }
      else { out = '\ufffd'; if (pos < input.length && pos >= RAW_LIMIT) cut = true }
    } else if (n >= 0xdc00 && n <= 0xdfff) out = '\ufffd'
    else out = String.fromCharCode(n)
    if (clean.length + (pendingSpace ? 1 : 0) + out.length > CLEAN_LIMIT) { cut = true; break }
    if (pendingSpace) { clean += ' '; pendingSpace = false }
    clean += out
  }
  if ((!lineEnded && pos < input.length) || state !== 'ground') cut = true
  // A budget cut or incomplete sequence may hide a continuation of the final
  // grapheme. Drop it rather than splitting a combining/ZWJ/flag sequence.
  const parts = [...getGraphemeSegmenter().segment(clean)]
  if (cut) parts.pop()
  let head = ''
  for (const { segment } of parts) {
    if (head.length + segment.length > OUTPUT_LIMIT) break
    head += segment
  }
  return `${head.trimEnd()}…`
}

function clip(value: string, limit: number): { output: string; used: number; clipped: boolean } {
  let output = ''
  let used = 0
  let clipped = false
  for (const { segment } of getGraphemeSegmenter().segment(value)) {
    const width = stringWidth(segment)
    if (used + width > limit) { clipped = true; break }
    output += segment
    used += width
  }
  return { output, used, clipped }
}

/** Fit a pre-sanitized one-line digest, preserving complete graphemes.
 * Marker and whole hints take priority over the label and preview. */
export function fitThinkingRow({ marker, label, preview, ctrlHint, clickHint, width }: {
  marker: string
  label: string
  preview: string
  ctrlHint: string
  clickHint: string
  width: number
}): string {
  for (const value of [marker, label, preview, ctrlHint, clickHint]) {
    if (/[\r\n\u2028\u2029\x00-\x1f\x7f-\x9f]/u.test(value)) throw new Error('thinking row must be single-line and control-free')
  }
  const budget = Math.max(0, Math.floor(width))
  const mark = clip(marker, budget)
  const ctrl = ctrlHint ? ` ${ctrlHint}` : ''
  const click = clickHint ? ` ${clickHint}` : ''
  let room = budget - mark.used
  const ctrlWidth = stringWidth(ctrl)
  const clickWidth = stringWidth(click)
  const selectedCtrl = ctrl && ctrlWidth <= room ? ctrl : ''
  if (selectedCtrl) room -= ctrlWidth
  const selectedClick = click && clickWidth <= room ? click : ''
  if (selectedClick) room -= clickWidth
  const fittedLabel = clip(label ? ` ${label}` : '', room)
  room -= fittedLabel.used
  let body = ''
  if (preview && room > 1) {
    const full = ` ${preview}`
    const fitted = clip(full, room)
    if (!fitted.clipped) body = full
    else {
      const prefix = clip(` ${preview.endsWith('…') ? preview.slice(0, -1) : preview}`, room - 1)
      body = (prefix.output.trimEnd() || ' ') + '…'
    }
  }
  return mark.output + fittedLabel.output.trimEnd() + body + selectedCtrl + selectedClick
}
