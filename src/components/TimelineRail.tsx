import React from 'react'
import { Box, Text, NoSelect, type ScrollBoxHandle } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import {
  RAIL_WIDTH,
  railEligible,
  computeRailGeometry,
  wrapPreviewLines,
  type TimelineTurn,
} from '../ink/timeline-rail.js'

/** ▴ / ▾ (U+25B4 / U+25BE — the small triangles; CP437-safe on ConHost too). */
const CHEVRON_UP = ' ▴'
const CHEVRON_DOWN = ' ▾'
/** Tick glyphs, right-aligned across the 2-col rail (Grok Build spec):
 *  active = heavy stroke, hover = wide light stroke, idle = short dim
 *  stroke in the rightmost cell. */
const TICK_ACTIVE = '━━'
const TICK_HOVER = '──'
const TICK_IDLE = ' ─'

/** Pointer rest time before the hover preview card pops (ms). Sweeps
 *  never mount a card; only a deliberate pause does. */
const HOVER_DWELL_MS = 120

/** What the pointer is over. One state so tick/chevron hovers can never
 *  overlap (the rail is 2 cols wide — a row is one target or the other). */
type Hover =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'tick'; index: number }
  | null

/**
 * Timeline rail: the fullscreen transcript's turn navigator — a 2-column
 * gutter REPLACING the classic scrollbar (Grok Build's timeline sidebar,
 * ported to the dsh Ink tree).
 *
 *  - one tick per user turn; tick position encodes conversation order,
 *    not scroll proportion (a long answer must not skew the timeline);
 *  - the tick of the turn owning the viewport top row (the turn being
 *    read — same anchor the sticky prompt header pins) renders as `━━`;
 *    hovering a tick widens it to `──` and pops a preview card left of
 *    the rail; idle ticks are a short dim ` ─`;
 *  - ▲ / ▾ scroll the tick WINDOW one row up/down (index browsing for
 *    many-turn sessions): they never jump a turn or move the transcript,
 *    and a dim chevron is a guaranteed no-op at either end of the index;
 *  - the wheel over the rail scrolls only that index window too (3 rows a
 *    notch); the transcript scrolls only from the content area;
 *  - clicking a tick jumps by content coordinate — the prompt's measured
 *    top — no element seek, no force-mount race;
 *  - more turns than rows: the window follows the active tick by default
 *    and pins to the tail while at the bottom; a browsed window stays put
 *    until the next real transcript scroll or tick jump;
 *  - hidden below 60 terminal columns, under 2 turns, under 3 viewport
 *    rows, or when the content fits (inline mode keeps the terminal's
 *    native scrollback).
 *
 * The whole 2-column width is the hit target; the rail is fenced with
 * NoSelect so click-drag text selection never picks up its glyphs, and
 * the wheel scrolls its own index window, never the transcript.
 */
export function TimelineRail({
  handle,
  turns,
  activeId,
  terminalWidth,
  hoverEnabled,
  onRevealTurn,
  onJumpTurn,
}: {
  handle: ScrollBoxHandle | null
  /** Turns in conversation order (MessageList's measured snapshot). */
  turns: ReadonlyArray<TimelineTurn>
  /** Turn owning the viewport top row (rail highlight target). */
  activeId: number | null
  terminalWidth: number
  /** False while a modal overlay owns the screen — suppress the hover
   *  card (the rail itself stays, but stops narrating). */
  hoverEnabled: boolean
  /**
   * Reveal-and-seek for FOLDED turns: the row sits inside a folded card
   * whose top is unknown until it mounts, so Chat expands it and seeks
   * through the force-mount path — the coordinate jump does not apply.
   */
  onRevealTurn: (rowId: number) => void
  /**
   * Seek for a turn with a measured top: Chat jumps by the content
   * coordinate (instant, works while the row is unmounted), then re-seats
   * on the prompt's TEXT top with a held anchor. The coordinate alone is
   * one row stale whenever the prefix re-measured after it was captured
   * (live deltas below, window quantization) — the reader lands with the
   * pinned header still naming the previous turn.
   */
  onJumpTurn: (rowId: number) => void
}): React.ReactNode {
  const [, setTick] = React.useState(0)
  const [hover, setHover] = React.useState<Hover>(null)
  // Dwell-gated preview card: the card pops only after the pointer RESTS
  // on a tick for HOVER_DWELL_MS. Sweeping the rail fires enter/leave per
  // cell — without the gate each crossing mounts an absolute-positioned
  // card at a new spot (flapping previews, absolute-rect churn, and the
  // fast-sweep residue users reported). The glyph highlight stays instant
  // (cheap, no overlay); only the card waits for intent.
  const [cardIndex, setCardIndex] = React.useState<number | null>(null)
  // Index browsing: while non-null, the rail shows this window start
  // instead of the auto window around the active tick. Set by the chevrons
  // and the wheel over the rail; cleared by any real transcript scroll or
  // tick jump (the subscribe callback below), so browsing never fights the
  // viewport for long.
  const [browseStart, setBrowseStart] = React.useState<number | null>(null)
  const dwellTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearDwell = React.useCallback(() => {
    if (dwellTimerRef.current !== null) {
      clearTimeout(dwellTimerRef.current)
      dwellTimerRef.current = null
    }
    setCardIndex(null)
  }, [])
  const armDwell = React.useCallback((index: number) => {
    if (dwellTimerRef.current !== null) clearTimeout(dwellTimerRef.current)
    dwellTimerRef.current = setTimeout(() => {
      dwellTimerRef.current = null
      setCardIndex(index)
    }, HOVER_DWELL_MS)
  }, [])
  React.useEffect(() => () => {
    if (dwellTimerRef.current !== null) clearTimeout(dwellTimerRef.current)
  }, [])
  React.useEffect(() => {
    if (!handle) return
    return handle.subscribe(() => {
      setTick(t => t + 1)
      // A real transcript scroll (wheel over the content, tick jump, header
      // click) slides the tick window under a STATIONARY pointer — without
      // this, the hover card keeps re-narrating whatever turn now sits under
      // the pointer cell, flapping previews across turns every frame (reads
      // as ghosting). OpenCode's modality rule: only a real mouse move may
      // re-enter hover; Grok likewise clears the hover popup on tick click.
      // setHover(null) on an already-null hover is a React no-op.
      setHover(null)
      clearDwell()
      // Browsing the index is a detour from the transcript; the next real
      // scroll hands the window back to the active tick.
      setBrowseStart(null)
    })
  }, [handle, clearDwell])

  if (!handle) return null
  const viewport = handle.getViewportHeight()
  const content = handle.getScrollHeight()
  const maxScroll = Math.max(0, content - viewport)
  if (!railEligible({
    turnCount: turns.length,
    terminalWidth,
    viewportRows: viewport,
    scrollable: content > viewport,
  })) return null

  const activeIndex = turns.findIndex(t => t.id === activeId)
  // Tail-pin the tick window while the viewport sits at the bottom
  // (sticky flag OR positional) — newest ticks stay on screen.
  const atBottom = handle.isSticky() || handle.getScrollTop() >= maxScroll
  const geo = computeRailGeometry(
    turns.length,
    viewport,
    activeIndex === -1 ? null : activeIndex,
    atBottom,
    browseStart,
  )
  if (!geo) return null

  // Jump by CONTENT COORDINATE, not by element: the target row is usually
  // unmounted (virtualization), and the element-based seek's force-mount
  // path races React's synchronous re-render (the renderer's deferred
  // Yoga read can see a detached anchor and silently no-op). The turn's
  // reported top is the measured text position — scrollTo() lands the
  // prompt exactly at the viewport top; the renderer clamps unreachable
  // tail tops to maxScroll (their turns stay on screen, just short of
  // owning the top row — and ▼ never names them, see timeline-rail.ts).
  // FOLDDED turns have no measured top (-1): their click (and ▲ naming
  // one) routes through onRevealTurn instead — expand the fold, then the
  // existing force-mount seek lands the row once it measures.
  const jumpToIndex = (index: number) => {
    const turn = turns[index]
    if (!turn) return
    // A tick click is also an explicit "return to follow": the jump can be a
    // no-op scroll (the turn already sits at the viewport top), in which case
    // no handle notification arrives to clear a browsed window.
    setBrowseStart(null)
    if (turn.folded) onRevealTurn(turn.id)
    else onJumpTurn(turn.id)
  }
  const shown = geo.windowEnd - geo.windowStart
  const maxWindowStart = Math.max(0, turns.length - shown)
  // Index-only scroll: moves the visible tick window, never the transcript
  // and never the jump target. Functional update so rapid wheel notches in
  // one frame compose instead of all reading the same stale window.
  const scrollIndexWindow = (delta: number) => {
    setBrowseStart(prev => {
      const current = prev === null ? geo.windowStart : prev
      const next = Math.min(Math.max(0, current + delta), maxWindowStart)
      return next === current ? prev : next
    })
    // The pointer is still over a row whose tick may now name another turn:
    // same modality rule as a transcript scroll — no ghost preview.
    setHover(null)
    clearDwell()
  }
  const chevron = (kind: 'up' | 'down') => {
    const enabled = kind === 'up' ? geo.windowStart > 0 : geo.windowEnd < turns.length
    const hovered = hover?.kind === kind
    const glyph = kind === 'up' ? CHEVRON_UP : CHEVRON_DOWN
    const color = !enabled ? 'subtle' : hovered ? 'text' : 'inactive'
    return (
      <Box
        key={kind}
        height={1}
        flexShrink={0}
        onClick={() => {
          if (enabled) scrollIndexWindow(kind === 'up' ? -1 : 1)
        }}
        // A repeat-click control: without a drag target the App's word-select
        // multi-click chain (500ms/±1 cell) swallows every second click at
        // the same cell — stepping the index by click would lose half the
        // steps. An (inert) drag target resets that chain at press: no
        // movement still replays the click, a real drag does nothing.
        onDragStart={() => {}}
        onMouseEnter={() => setHover({ kind })}
        onMouseLeave={() => setHover(null)}
      >
        <Text color={color}>{glyph}</Text>
      </Box>
    )
  }

  const tickRows: React.ReactNode[] = []
  for (let k = 0; k < shown; k++) {
    const index = geo.windowStart + k
    const turn = turns[index]!
    const isActive = index === activeIndex
    const isHovered = hover?.kind === 'tick' && hover.index === index
    const glyph = isActive ? TICK_ACTIVE : isHovered ? TICK_HOVER : TICK_IDLE
    const color = isActive || isHovered ? 'text' : 'subtle'
    tickRows.push(
      <Box
        key={turn.id}
        height={1}
        flexShrink={0}
        onClick={() => jumpToIndex(index)}
        onMouseEnter={() => {
          setHover({ kind: 'tick', index })
          armDwell(index)
        }}
        onMouseLeave={() => {
          setHover(null)
          clearDwell()
        }}
      >
        <Text color={color}>{glyph}</Text>
      </Box>,
    )
  }

  // Hover preview card, anchored left of the rail and vertically centered
  // on the hovered tick (shrink-to-fit, rounded chrome). Dwell-gated: only
  // cardIndex (armed after HOVER_DWELL_MS of rest) draws — a sweep keeps
  // hover flashing on glyphs but never mounts the overlay. Suppressed
  // while an overlay owns the screen — the rail stops narrating over
  // dialogs.
  let card: React.ReactNode = null
  if (hoverEnabled && cardIndex !== null) {
    const turn = turns[cardIndex]
    if (turn && turn.preview.length > 0) {
      const tickRow = geo.tickTop + cardIndex - geo.windowStart
      if (tickRow >= geo.tickTop && tickRow < geo.downRow) {
        const budget = Math.min(32, Math.max(16, Math.floor((terminalWidth - RAIL_WIDTH) / 2)))
        const lines = wrapPreviewLines(turn.preview, budget)
        if (lines.length > 0 && lines.some(l => l.length > 0)) {
          const widest = Math.max(...lines.map(l => stringWidth(l)))
          const cardW = widest + 4 // rounded border ×2 + padding ×2
          const cardH = lines.length + 2
          if (cardH <= viewport) {
            const top = Math.max(0, Math.min(tickRow - Math.floor(cardH / 2), viewport - cardH))
            card = (
              <Box
                position="absolute"
                top={top}
                right={RAIL_WIDTH + 1}
                width={cardW}
                height={cardH}
                flexDirection="column"
                flexShrink={0}
                borderStyle="round"
                borderColor="inactive"
                // An opaque surface, like every other card floating over the
                // transcript (Tooltip's card uses the same token). Without it
                // the card is translucent: the rows underneath show through
                // the padding/border columns, so the transcript's own fills
                // leak out beside each preview line (reported from a real
                // session: one line leaked the message background, the next a
                // terminal-default gap).
                backgroundColor="toolCardBackground"
                paddingX={1}
                // The card floats LEFT of the rail over selectable
                // transcript text; fence its own rect so a drag that
                // happens under a dwell-popped preview never copies the
                // card's preview glyphs. On the box itself (not a NoSelect
                // wrapper): absolute children don't contribute to a flow
                // wrapper's layout, so a wrapper's region would be 0×0.
                noSelect
              >
                {lines.map((line, i) => (
                  <Text key={i} color="text" wrap="truncate-end">{line}</Text>
                ))}
              </Box>
            )
          }
        }
      }
    }
  }

  return (
    // Plain NoSelect (box region only): the rail is a RIGHT-side gutter,
    // so fromLeftEdge's [col 0 → box right edge] region would fence the
    // ENTIRE transcript row — the copy-on-select regression where every
    // drag copied ~nothing (the hover card below carries its own noSelect
    // for the same reason: it floats over selectable transcript text).
    <NoSelect>
      {/* Raw ink-box (not the themed Box): onWheel is a host-level prop
          (same as ScrollBox's viewport). The wheel here scrolls the rail's
          OWN tick window — the rail is an index, so a notch flips the
          index, not the transcript. The row above extends past the page
          margin (Chat), so this gutter naturally lands at the terminal's
          right edge. */}
      <ink-box
        onWheel={e => {
          if (e.deltaY === 0) return
          scrollIndexWindow(Math.sign(e.deltaY) * 3)
        }}
        style={{ flexDirection: 'column', flexShrink: 0, width: RAIL_WIDTH }}
      >
        <Box height={geo.upRow} flexShrink={0} />
        {chevron('up')}
        {tickRows}
        {chevron('down')}
        {card}
      </ink-box>
    </NoSelect>
  )
}
