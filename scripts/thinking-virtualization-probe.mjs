/* Real Chat + synthetic channel + physical xterm; independent of DSH history
 * chunking and LRU. Run via verify-thinking-virtualization.mjs --run;
 * no forceRedraw.
 * DOM row identity and MessageList window are both checked on each side of
 * the scroll; offscreen pixels alone do not establish virtualization.
 */
import assert from 'node:assert/strict'
const repoRoot = new URL('../', import.meta.url)
const { rig, setLang, sleep } = await import(new URL('scripts/thinking-virtualization-rig.mjs', repoRoot).href)
const HEAD = 'VIRT_REASON_HEAD', MID = 'VIRT_REASON_MIDDLE', TAIL = 'VIRT_REASON_TAIL'
const NEXT = 'VIRT_NEXT_ROW_SENTINEL'
const thinkingText = `${HEAD} short explanation\n\n${MID} complete middle paragraph\n\n${TAIL} complete final paragraph`
const beforeRows = Array.from({ length: 124 }, (_, i) => ({ id: i + 1, kind: 'assistant', text: `VIRTUAL_FILLER_${i}`, streaming: false }))
const target = { id: 125, kind: 'reasoning', text: thinkingText, streaming: false, thinkingOpen: false }
const afterRows = [{ id: 126, kind: 'assistant', text: NEXT, streaming: false },
  ...Array.from({ length: 4 }, (_, i) => ({ id: 127 + i, kind: 'assistant', text: `VIRTUAL_AFTER_${i}`, streaming: false }))]
const rows = [...beforeRows, target, ...afterRows]
const index = rows.findIndex(row => row.id === target.id)
const boundary = rows.length - 120, windowIndex = index - boundary
assert.ok(rows.length > 120 && index > boundary && index < rows.length - 1)
assert.equal(rows[index + 1].text, NEXT, 'fixed order places the sentinel directly after the reasoning row')
assert.ok(rows.every(row => !('folded' in row) && !('collapsed' in row)), 'fixture contains no historical chunks')
const has = (app, text) => app.screen().some(line => line.includes(text))
const header = line => /(?:⚓|\*)\s+Thinking\b/u.test(line)
const full = app => [HEAD, MID, TAIL].every(text => has(app, text))
const summaryLine = app => app.screen().find(line => header(line) && line.includes(HEAD) && line.includes('…') && /click\s+to\s+expand/i.test(line))
const inWindow = note => note && note.rowCount === 120 && windowIndex >= note.start && windowIndex < note.end
const outWindow = note => note && note.rowCount === 120 && (windowIndex < note.start || windowIndex >= note.end)
let app
try {
  setLang('en')
  app = await rig({ columns: 100, rows: 45, initialRows: rows, thinkingFold: 'preview' })
  assert.ok(await app.wait(() => Boolean(summaryLine(app)) && has(app, NEXT) && inWindow(app.geometry()), 5000), 'settled folded target and adjacent row must paint inside the last-120 window')
  assert.equal(has(app, MID) || has(app, TAIL), false, 'folded summary must hide the remaining body')
  const originalSummary = summaryLine(app)
  const initialRow = app.rowNode(HEAD, NEXT)
  assert.ok(initialRow && app.attached(initialRow), 'actual reasoning row wrapper must be attached before opening')
  console.log(`INITIAL ${JSON.stringify({ total: rows.length, index, boundary, windowIndex, geometry: app.geometry(), frame: app.frame(), scrollTop: app.scroll()?.scrollTop })}`)

  assert.ok(await app.click('Thinking', header), 'a real SGR press/release must hit the visible settled summary')
  const openClick = app.lastClick()
  assert.ok(await app.wait(() => full(app) && has(app, NEXT), 5000), 'all reasoning content must paint in a new parsed frame')
  const openRow = app.rowNode(HEAD, NEXT)
  assert.ok(openRow && app.attached(openRow), 'opened reasoning wrapper must be attached')
  assert.ok(inWindow(app.geometry()), 'opened target remains inside the virtual window')
  console.log(`OPEN ${JSON.stringify({ click: openClick, frame: app.frame(), geometry: app.geometry(), scrollTop: app.scroll()?.scrollTop })}`)
  await sleep(600) // 固定窗:墙钟 wait beyond terminal double-click recognition before the later closing click

  let unmounted = false, pageCount = 0
  for (; pageCount < 12; pageCount++) {
    const prevTop = app.scroll()?.scrollTop
    assert.ok(typeof prevTop === 'number' && prevTop > 0, 'there must be room to page upward')
    app.input('\x1b[5~')
    assert.ok(await app.wait(() => typeof app.scroll()?.scrollTop === 'number' && app.scroll().scrollTop < prevTop, 5000), 'PageUp must produce a new parsed frame with upward movement')
    if (!app.attached(openRow) && outWindow(app.geometry())) { unmounted = true; break }
  }
  assert.ok(unmounted, 'the captured DOM row object must be detached and its index outside the mounted window')
  assert.equal(has(app, MID) || has(app, TAIL), false, 'expanded body must no longer occupy the physical viewport')
  console.log(`UNMOUNT ${JSON.stringify({ pages: pageCount + 1, frame: app.frame(), geometry: app.geometry(), scrollTop: app.scroll()?.scrollTop, attached: app.attached(openRow) })}`)

  app.input('\x1b[F')
  assert.ok(await app.wait(() => full(app) && has(app, NEXT) && inWindow(app.geometry()), 5000), 'End must return to the same expanded body in a new parsed frame')
  const remounted = app.rowNode(HEAD, NEXT)
  assert.ok(remounted && app.attached(remounted), 'the reasoning row must be attached again')
  assert.notEqual(remounted, openRow, 'remount must produce a new DOM row object')
  assert.equal(app.attached(openRow), false, 'the old row object must remain detached')
  console.log(`REMOUNT ${JSON.stringify({ frame: app.frame(), geometry: app.geometry(), scrollTop: app.scroll()?.scrollTop, expanded: full(app) })}`)

  assert.ok(await app.click('Thinking', header), 'a second real SGR click must hit the re-mounted header')
  const closeClick = app.lastClick()
  assert.ok(await app.wait(() => Boolean(summaryLine(app)) && !has(app, MID) && !has(app, TAIL) && has(app, NEXT), 5000), 'new parsed frame must restore the folded summary')
  // Compare exact visible text apart from trailing ASCII spaces only; this
  // probe does not validate the style of trailing blank terminal cells.
  assert.equal(summaryLine(app).replace(/ +$/u, ''), originalSummary.replace(/ +$/u, ''), 'the same original summary must be restored')
  assert.ok(app.rowNode(HEAD, NEXT) && inWindow(app.geometry()), 'the same logical row remains mounted after collapsing')
  console.log(`CLOSED ${JSON.stringify({ click: closeClick, frame: app.frame(), geometry: app.geometry() })}`)
} finally {
  await app?.close()
}
