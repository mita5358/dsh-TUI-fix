/** UTF-16 offsets of a path-like candidate in the original input. */
export type PathSpan = { offset: number; end: number }

// Capture the primitive so a reentrant callback cannot change later scans.
const codeAt = Function.prototype.call.bind(String.prototype.charCodeAt) as (text: string, index: number) => number
const separator = (n: number) => n === 47 || n === 92
const letter = (n: number) => (n >= 65 && n <= 90) || (n >= 97 && n <= 122)
const alphanumeric = (n: number) => letter(n) || (n >= 48 && n <= 57)

// ECMAScript \s and the original path-span exclusions. Surrogate code units
// remain allowed; the actual path validation rejects ill-formed UTF-16.
function excluded(n: number): boolean {
  return (n >= 9 && n <= 13) || n === 0x20 || n === 0x00a0 || n === 0x1680 ||
    (n >= 0x2000 && n <= 0x200a) || n === 0x2028 || n === 0x2029 ||
    n === 0x202f || n === 0x205f || n === 0x3000 || n === 0xfeff ||
    n === 60 || n === 62 || n === 34 || n === 39 || n === 96 ||
    n === 124 || n === 63 || n === 35
}

function anchored(text: string, index: number, end: number): boolean {
  const c = codeAt(text, index)
  const n1 = index + 1 < end ? codeAt(text, index + 1) : -1
  const n2 = index + 2 < end ? codeAt(text, index + 2) : -1
  return separator(c) || (c === 126 && separator(n1)) ||
    (c === 46 && (separator(n1) || (n1 === 46 && separator(n2)))) ||
    (letter(c) && n1 === 58 && separator(n2))
}

/** Yield path-like spans, including those later rejected by path validation. */
export function* scanPathSpans(text: string, stats = { steps: 0 }): Generator<PathSpan> {
  let cursor = 0
  while (cursor < text.length) {
    stats.steps++
    if (excluded(codeAt(text, cursor))) { cursor++; continue }
    const start = cursor
    let firstSlash = -1
    let lastDot = -1
    while (cursor < text.length && !excluded(codeAt(text, cursor))) {
      stats.steps++
      const c = codeAt(text, cursor)
      if (firstSlash < 0 && separator(c)) firstSlash = cursor
      if (c === 46 && cursor + 1 < text.length && alphanumeric(codeAt(text, cursor + 1))) lastDot = cursor
      cursor++
    }
    // Both candidate forms require a slash; avoid rescanning ordinary words.
    if (firstSlash < 0) continue
    const end = cursor
    if (anchored(text, start, end)) { yield { offset: start, end }; continue }
    let remainder = start
    if (lastDot > firstSlash) {
      let matchedEnd = lastDot + 1
      let count = 0
      while (matchedEnd < end && count < 6 && alphanumeric(codeAt(text, matchedEnd))) {
        matchedEnd++; count++; stats.steps++
      }
      yield { offset: start, end: matchedEnd }
      remainder = matchedEnd
    }
    // A successful unanchored match consumed the last eligible dot. If it
    // failed at the run start, it cannot succeed later within that run.
    for (let i = remainder; i < end; i++) {
      stats.steps++
      if (anchored(text, i, end)) { yield { offset: i, end }; break }
    }
  }
}

/** Return the start of the trailing ASCII punctuation suffix. */
export function trailingPathPunctuationStart(text: string, stats = { inspected: 0 }): number {
  let end = text.length
  while (end > 0) {
    stats.inspected++
    const ch = codeAt(text, end - 1)
    if (ch !== 46 && ch !== 44 && ch !== 59 && ch !== 58 && ch !== 33 && ch !== 63) break
    end--
  }
  return end
}
