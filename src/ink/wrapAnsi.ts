import wrapAnsiNpm from 'wrap-ansi'

type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

/**
 * One incremental slot for printable ASCII without line breaks or controls.
 * With hard wrapping and no trimming every character is one cell, but growing
 * the final word can move it into the preceding row. Retain that row and the
 * entire final word; only earlier rows are stable. A single word starts at
 * column zero, so its complete rows are stable. Other input/options use the
 * upstream implementation. Copying/joining stable rows is still O(total).
 */
interface WrapSlot {
  columns: number
  wordWrap: boolean | undefined
  input: string
  headRows: string[]
  remainder: string
}

const SLOT_MIN_LENGTH = 2048
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/u
let slot: WrapSlot | null = null

/** Retain the earliest row that an appended final word can affect. */
function nextSlot(input: string, columns: number, wordWrap: boolean | undefined, rows: string[]): WrapSlot | null {
  // This checks conservation, not line-break correctness. The retained rows
  // must originate from upstream or from an already valid incremental slot.
  // Compare by span rather than allocating another full-size joined string.
  let offset = 0
  for (const row of rows) {
    if (!input.startsWith(row, offset)) return null
    offset += row.length
  }
  if (offset !== input.length) return null
  const wordStart = input.lastIndexOf(' ') + 1
  let wordRow = rows.length - 1
  if (wordStart > 0 && wordStart < input.length) {
    let end = input.length
    while (wordRow > 0) {
      const start = end - rows[wordRow]!.length
      if (wordStart >= start && wordStart < end) break
      end = start
      wordRow -= 1
    }
  }
  // The very first word starts at column zero; otherwise a changed final
  // word can also affect the row immediately before its old first character.
  const keep = wordStart === 0 ? rows.length - 1 : Math.max(0, wordRow - 1)
  return {
    columns, wordWrap, input,
    headRows: rows.slice(0, keep),
    remainder: rows.slice(keep).join(''),
  }
}

function wrapAnsiNpmIncremental(
  input: string,
  columns: number,
  options: WrapAnsiOptions | undefined,
): string {
  // Clear first so a failed or ineligible wrap cannot leave a stale slot.
  const previous = slot
  slot = null
  const eligible = typeof input === 'string' && input.length > SLOT_MIN_LENGTH &&
    Number.isSafeInteger(columns) && columns > 0 && options?.hard === true && options.trim === false
  const wordWrap = eligible ? options.wordWrap : undefined
  const slottable = eligible && (wordWrap === undefined || typeof wordWrap === 'boolean')
  if (slottable && previous !== null && previous.columns === columns &&
      previous.wordWrap === wordWrap && input.startsWith(previous.input)) {
    const suffix = input.slice(previous.input.length)
    if (!NON_PRINTABLE_ASCII.test(suffix)) {
      const tail = wrapAnsiNpm(previous.remainder + suffix, columns, options).split('\n')
      const rows = [...previous.headRows, ...tail]
      const next = nextSlot(input, columns, wordWrap, rows)
      if (next !== null) {
        const result = rows.join('\n')
        slot = next
        return result
      }
      // Never return an incremental result that failed conservation.
    }
  }
  const result = wrapAnsiNpm(input, columns, options)
  if (slottable && !NON_PRINTABLE_ASCII.test(input)) {
    slot = nextSlot(input, columns, wordWrap, result.split('\n'))
  }
  return result
}

/**
 * Wrap a string to a maximum column width, preserving ANSI escape sequences.
 *
 * Uses wrap-ansi (with the incremental fast path for growing streaming inputs).
 * @param input - the string to wrap.
 * @param columns - the maximum width in columns.
 * @param options - wrap options: hard breaks long words, wordWrap splits on word boundaries, trim strips trailing whitespace.
 * @returns the wrapped string.
 */
const wrapAnsi: (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string =
  wrapAnsiNpmIncremental

export { wrapAnsi }
