/**
 * "Load all messages" must not move the reader, and a wheel-up held at the
 * top edge must page in older rows WITHOUT the viewport teleporting to them.
 *
 * Both failures have one shape: the mount floor moves, so the rows above the
 * anchor change height in content coordinates while `scrollTop` stays put.
 * The renderer then paints whatever now lives at that offset — the oldest
 * rows of the window — and the rail's active turn follows the viewport top,
 * so the sidebar jumps too. MessageList's anchor pass must correct by the
 * anchored row's OWN offset delta, and resolve that row by id (the stored
 * window index is stale the moment the floor moves).
 *
 * The page-in half is the same correction driven from a wheel gesture: five
 * notches in one burst at scrollTop 0 commit exactly ONE 100-row page, after
 * the wheel settles, and the reader's row keeps its screen line. A plain
 * `scrollTo(0)` (seek, sticky re-pin, rail jump) has no negative wheel debt
 * and must never page.
 *
 * Run: node --import tsx/esm scripts/verify-top-page-load.tsx
 */
process.env.NODE_ENV = 'production'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
import '../src/force-production-react.js'

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import type { ScrollBoxHandle } from '../src/ui.js'
import type { ChatRow } from '../src/dsh-adapter/channel.js'
import type { DOMElement } from '../src/ink/dom.js'
import { settled, sleep } from './lib/term-test.mjs'

const [React, { Box, render, ScrollBox }, { MessageList }, { nodeCache }] = await Promise.all([
  import('react'),
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('../src/ink/node-cache.js'),
])

class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Sink extends Writable {
  isTTY = true
  columns = 100
  rows = 30
  _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) { done() }
}

const ROWS_N = 320
const CAP_FLOOR = ROWS_N - 120 + 1 // first id of the default 120-row window
const PAGE_FLOOR = CAP_FLOOR - 100 // first id after exactly one page-in

// Every fourth row opens a turn, so the rail's active turn is observable.
const rows: ChatRow[] = Array.from({ length: ROWS_N }, (_, i) => i % 4 === 3
  ? { id: i + 1, kind: 'user', text: `turn ${(i + 1) / 4}` }
  : {
    id: i + 1, kind: 'tool', text: '',
    tool: {
      callId: `call-${i}`, name: 'Read', argsText: `module-${i + 1}.ts`,
      status: 'ok', startedAt: 0, durationMs: 5,
      resultText: `source ${i + 1} first\nsource ${i + 1} second`,
    },
  })

let showAll = false
let handle: ScrollBoxHandle | null = null
let activeTurn: number | null | undefined
const mounted = new Map<number, DOMElement>()
const expandedRows = new Set<number>()
const noop = (): void => {}
const reportTimeline = (state: { activeId: number | null }): void => { activeTurn = state.activeId }
const registerRowRef = (id: number, el: DOMElement | null): void => {
  if (el) mounted.set(id, el)
  else mounted.delete(id)
}

function Harness(): React.ReactElement {
  const [scroll, setScroll] = React.useState<ScrollBoxHandle | null>(null)
  handle = scroll
  return <Box flexDirection="column" height={24}>
    <ScrollBox ref={setScroll} height={20} stickyScroll flexDirection="column">
      <MessageList rows={rows} expanded={false} expandedRows={expandedRows} selectedId={null}
        onToggleRow={noop} model="test" showAll={showAll} onToggleAll={noop}
        registerRowRef={registerRowRef} scrollHandle={scroll} onTimeline={reportTimeline} />
    </ScrollBox>
  </Box>
}

/** The mounted row whose box covers the viewport's first line. */
function rowAtViewportTop(): { id: number; screenY: number } | null {
  if (handle === null) return null
  const viewportTop = handle.getViewportTop()
  let pick: { id: number; y: number } | null = null
  for (const [id, el] of mounted) {
    const rect = nodeCache.get(el)
    if (rect === undefined) continue
    if (rect.y > viewportTop || rect.y + rect.height <= viewportTop) continue
    if (pick === null || rect.y > pick.y) pick = { id, y: rect.y }
  }
  return pick === null ? null : { id: pick.id, screenY: pick.y }
}

function screenYOf(id: number): number | undefined {
  const el = mounted.get(id)
  return el === undefined ? undefined : nodeCache.get(el)?.y
}

async function mount(): Promise<{ app: Awaited<ReturnType<typeof render>>; frames: () => number }> {
  let frames = 0
  const app = await render(<Harness />, {
    stdout: new Sink() as unknown as NodeJS.WriteStream,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    stderr: new Sink() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: () => { frames += 1 },
  })
  return { app, frames: () => frames }
}

// --- 1. "load all messages" while reading the middle of the tail window ----
{
  showAll = false
  const { app } = await mount()
  try {
    assert.ok(await settled(() => handle !== null && mounted.size > 0), 'the tail window must mount')
    assert.ok(mounted.has(ROWS_N), 'the sticky tail starts at the newest row')
    assert.ok(!mounted.has(CAP_FLOOR - 1), 'rows above the 120-row cap start unmounted')

    handle!.scrollTo(320)
    assert.ok(await settled(() => !handle!.isSticky() && rowAtViewportTop() !== null),
      'a manual position must leave sticky and mount a row under the viewport top')
    await sleep(80) // let the anchor pass record the committed position
    const before = rowAtViewportTop()!
    const scrollBefore = handle!.getScrollTop()
    const turnBefore = activeTurn

    showAll = true
    app.rerender(<Harness />)
    assert.ok(await settled(() => mounted.has(before.id) && handle!.getScrollTop() !== scrollBefore),
      'showAll must keep the anchored row mounted and re-anchor the position')
    assert.equal(activeTurn, turnBefore, 'the rail must keep the same active turn')
    const after = rowAtViewportTop()
    assert.ok(after !== null, 'a row must still own the viewport top')
    assert.equal(after!.id, before.id, 'showAll must keep the SAME row under the viewport top')
    assert.ok(Math.abs(after!.screenY - before.screenY) <= 1,
      `showAll moved the anchored row by ${after!.screenY - before.screenY} lines`)
    assert.ok(handle!.getScrollTop() > scrollBefore + 100,
      'the position must shift by the inserted prefix, not stay on the old offset')
    console.log('PASS: showAll keeps the reader anchored')
  } finally {
    await app.unmount()
  }
}

// --- 2. wheel-up at the top edge pages in exactly one 100-row block --------
{
  showAll = false
  const { app } = await mount()
  try {
    assert.ok(await settled(() => handle !== null && mounted.size > 0), 'the tail window must mount')
    assert.ok(!mounted.has(CAP_FLOOR - 1), 'rows above the 120-row cap start unmounted')
    handle!.scrollTo(0)
    assert.ok(await settled(() => handle!.getScrollTop() === 0 && mounted.has(CAP_FLOOR) && !handle!.isSticky()),
      'the manual position reaches the top of the capped window')
    await sleep(80)
    const yBefore = screenYOf(CAP_FLOOR)
    assert.notEqual(yBefore, undefined, 'the window floor row must be mounted at the top')

    // A seek/position lands with no negative wheel debt: never a page-in.
    await sleep(400)
    assert.ok(!mounted.has(PAGE_FLOOR), 'a programmatic scrollTo(0) must not page in older rows')

    // One flick = one page. Five notches collapse into a single mount.
    for (let i = 0; i < 5; i += 1) handle!.scrollBy(-3)
    assert.ok(await settled(() => handle!.getScrollTop() > 100),
      'the page-in must re-anchor the position instead of jumping to offset 0')
    await sleep(350) // a second page would land here if the burst paged per notch
    const yAfter = screenYOf(CAP_FLOOR)
    assert.notEqual(yAfter, undefined, 'the page-in must keep the previous floor row mounted')
    assert.ok(Math.abs(yAfter! - yBefore!) <= 2,
      `the page-in moved the reader's row by ${yAfter! - yBefore!} lines`)
    assert.ok(!mounted.has(PAGE_FLOOR), 'the paged block sits above the anchor until it is scrolled into')

    handle!.scrollTo(0)
    assert.ok(await settled(() => mounted.has(PAGE_FLOOR)),
      'after one page the next older 100 rows are reachable')
    assert.ok(!mounted.has(1), 'a five-notch burst mounts ONE page, not five')
    console.log('PASS: top-edge wheel pages in one anchored block')
  } finally {
    await app.unmount()
  }
}

// --- 3. the paged-in block is reachable by scrolling, not just by count ----
{
  showAll = false
  const { app } = await mount()
  try {
    assert.ok(await settled(() => handle !== null && mounted.size > 0), 'the tail window must mount')
    handle!.scrollTo(0)
    assert.ok(await settled(() => handle!.getScrollTop() === 0 && mounted.has(CAP_FLOOR) && !handle!.isSticky()),
      'the capped window exposes its first row at the top')
    handle!.scrollBy(-3)
    assert.ok(await settled(() => handle!.getScrollTop() > 100))
    // Walk up smoothly (programmatic, so no second gesture): the anchor stays
    // put, then the paged rows mount as they enter the viewport.
    for (let y = handle!.getScrollTop(); y >= 0; y -= 80) {
      handle!.scrollTo(Math.max(0, y))
      await sleep(20)
    }
    handle!.scrollTo(0)
    assert.ok(await settled(() => mounted.has(PAGE_FLOOR)),
      'scrolling up reaches the paged block')
    assert.ok(!mounted.has(1), 'one page only')
    console.log('PASS: the paged block is reachable by scrolling up')
  } finally {
    await app.unmount()
  }
}

console.log('top page load passed (anchored showAll, one page per top-edge gesture)')
