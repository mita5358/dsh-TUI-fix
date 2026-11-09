/** Return the final lines used by the live thinking ticker without splitting
 *  or allocating an array for every earlier line. `count` must be a positive integer. */
export function thinkingTickerTail(text: string, count: number): { lines: string[]; clipped: boolean } {
  const lines: string[] = []
  let end = text.length
  while (lines.length < count) {
    const separator = end > 0 ? text.lastIndexOf('\n', end - 1) : -1
    lines.push(text.slice(separator + 1, end))
    if (separator < 0) return { lines: lines.reverse(), clipped: false }
    end = separator
  }
  return { lines: lines.reverse(), clipped: true }
}
