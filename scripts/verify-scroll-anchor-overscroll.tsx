/**
 * ScrollBox held-anchor vs bottom overscroll regression.
 * Run via node scripts/verify-scroll-anchor-overscroll.mjs: the wrapper sets
 * production before the child starts and creates private temporary state.
 * No real terminal/session/credentials. Event-driven; timeouts are bounds only.
 * Non-Linux platforms have not been validated.
 */
import assert from 'node:assert/strict'
import { openSync, closeSync, writeSync, writeFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { DOMElement } from '../src/ink/dom.js'
import type { ScrollBoxHandle } from '../src/ui.js'

if (process.env.NODE_ENV !== 'production') throw new Error('prerequisite: NODE_ENV must be production before process startup')
const scratch = process.env.DSH_OVERSCROLL_SCRATCH
const tempRoot = process.env.DSH_OVERSCROLL_TEMP_ROOT
if (!scratch || !tempRoot || realpathSync(scratch) !== scratch || realpathSync(tempRoot) !== tempRoot ||
  dirname(scratch) !== tempRoot || !basename(scratch).startsWith('dsh-scroll-anchor-overscroll-') ||
  process.env.HOME !== scratch || process.env.RESULT_TRACE !== join(scratch, 'trace.json')) {
  throw new Error('prerequisite: wrapper-owned private temporary HOME required')
}
const [React, { Terminal }, { render, AlternateScreen, Box, ScrollBox, Text }] = await Promise.all([
  import('react'), import('@xterm/headless'), import('../src/ui.js'),
])
const COLS = 60, ROWS = 14, VIEWPORT = 8

class PrerequisiteError extends Error {}
function pre(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PrerequisiteError(message)
}
const reports: unknown[] = []
let failures = 0, prerequisites = 0
const boundedEvents: unknown[] = []
let dropped = 0
const record = (v: unknown) => { if (boundedEvents.length < 512) boundedEvents.push(v); else dropped++ }
process.on('exit', code => {
  const path = process.env.RESULT_TRACE
  if (path) {
    try { writeFileSync(path, JSON.stringify({ code, reports, dropped, events: boundedEvents }, null, 2)) }
    catch (error) { try { process.stderr.write(`trace write failed: ${String(error)}\n`) } catch {} }
  }
})

class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

async function scenario(name: 'bottom-noop' | 'up-control' | 'seek-then-down') {
  const ttyPath = join(scratch!, `${name}.tty`)
  const fd = openSync(ttyPath, 'wx+', 0o600)
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  let frame = 0, writes = 0, pending = 0, revision = 0
  let ttyBytes = 0, ttyOverflow = false
  const ttyLimit = 2 * 1024 * 1024
  let handle: ScrollBoxHandle | null = null
  let target: DOMElement | null = null
  let app: Awaited<ReturnType<typeof render>> | undefined
  const frameSamples: Array<{ frame: number; top: number | undefined; max: number; sticky: boolean | undefined; anchorPresent: boolean }> = []
  let frameSamplesDropped = 0
  const listeners = new Set<() => void>()
  const wake = () => { for (const listener of [...listeners]) listener() }
  class Output extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    fd = fd
    _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
      try {
        const remaining = Math.max(0, ttyLimit - ttyBytes)
        if (remaining > 0) writeSync(fd, chunk.subarray(0, remaining))
        ttyBytes += chunk.length
        if (ttyBytes > ttyLimit) ttyOverflow = true
        writes++; pending++
      } catch (error) { done(error as Error); return }
      term.write(chunk.toString(), () => { pending--; done(); wake() })
    }
  }
  const out = new Output(), input = new Input()
  const err = Object.assign(new Writable({ write(_chunk, _enc, done) { done() } }), { isTTY: false, fd })
  const screen = () => Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? '')
  const scrollNode = (): DOMElement | undefined => {
    let node = target?.parentNode
    while (node && node.scrollViewportHeight === undefined) node = node.parentNode
    return node
  }
  const rootAttached = () => {
    let node = target
    while (node && node.nodeName !== 'ink-root') node = node.parentNode ?? null
    return node?.nodeName === 'ink-root'
  }
  const max = () => Math.max(0, (handle?.getScrollHeight() ?? 0) - (handle?.getViewportHeight() ?? 0))
  const sample = (event: string) => {
    const scroll = scrollNode()
    const data = { case: name, event, frame, writes, pending, top: handle?.getScrollTop(), max: max(), sticky: handle?.isSticky(),
      pendingDelta: handle?.getPendingDelta(), intent: handle?.getScrollIntentVersion(), anchorPresent: !!scroll?.scrollAnchor,
      anchorHeld: scroll?.scrollAnchor?.hold ?? false, targetAttached: rootAttached(),
      targetTop: target?.yogaNode?.getComputedTop(), targetHeight: target?.yogaNode?.getComputedHeight() }
    record(data)
    return data
  }
  const when = (label: string, condition: () => boolean, prerequisite = false) => new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>
    const check = () => {
      try {
        if (!condition()) return
        clearTimeout(timeout); listeners.delete(check); resolve()
      } catch (error) { clearTimeout(timeout); listeners.delete(check); reject(error) }
    }
    timeout = setTimeout(() => { listeners.delete(check); const message = `timed out waiting for ${label}`; reject(prerequisite ? new PrerequisiteError(message) : new Error(message)) }, 5000)
    listeners.add(check)
    check()
  })
  const parsed = () => pending === 0 && out.writableLength === 0
  const intents: string[] = []
  const firstIntent = () => intents.push('first')
  const secondIntent = () => intents.push('second')
  let onScrollByIntent = firstIntent
  const tree = () => <AlternateScreen><Box height={ROWS} flexDirection="column">
    <ScrollBox ref={value => { handle = value }} onScrollByIntent={onScrollByIntent} height={VIEWPORT} width={COLS} stickyScroll flexDirection="column">
      {Array.from({ length: 35 }, (_, i) => <Box key={i} height={1}><Text>{`PREFIX-${i}`}</Text></Box>)}
      <Box ref={value => { target = value }} height={10} flexShrink={0}>
        <Text>{Array.from({ length: 10 }, (_, i) => `TARGET-${i}`).join('\n')}</Text>
      </Box>
      {Array.from({ length: 5 }, (_, i) => <Box key={`t${i}`} height={1}><Text>{`TAIL-${i}`}</Text></Box>)}
    </ScrollBox><Text>{`FOOTER-${revision}`}</Text>
  </Box></AlternateScreen>
  try {
    app = await render(tree(), { stdout: out as never, stdin: input as never, stderr: err as never,
      exitOnCtrlC: false, patchConsole: false, onFrame: () => {
        frame++
        const f = sample('frame')
        if (frameSamples.length < 128) frameSamples.push({ frame, top: f.top, max: f.max, sticky: f.sticky, anchorPresent: f.anchorPresent })
        else frameSamplesDropped++
        wake()
      } })
    await when('initial sticky bottom and xterm parse', () => !!handle && !!target && frame > 0 && parsed() &&
      handle.getViewportHeight() === VIEWPORT && handle.getScrollHeight() > VIEWPORT &&
      handle.isSticky() && handle.getScrollTop() === max() && screen().some(line => line.includes('TAIL-4')), true)
    const h = handle as ScrollBoxHandle | null, el = target as DOMElement | null
    pre(h && el, 'handle and target mounted')
    pre(rootAttached(), 'target is attached to the live root')
    const box = scrollNode()
    pre(box, 'target has a scrollbox ancestor')
    const top = el.yogaNode?.getComputedTop(), height = el.yogaNode?.getComputedHeight()
    const firstTextOffset = (node: DOMElement, offset = 0): number | undefined => {
      for (const child of node.childNodes) {
        if (child.nodeName === '#text') { if (child.nodeValue.trim()) return offset; continue }
        const found = firstTextOffset(child, offset + (child.yogaNode?.getComputedTop() ?? 0))
        if (found !== undefined) return found
      }
    }
    const textOffset = firstTextOffset(el)
    pre(top !== undefined && height !== undefined && textOffset !== undefined && top + textOffset < max() && top + height > max(),
      `target text must straddle viewport top, got top=${top} textOffset=${textOffset} height=${height} max=${max()}`)
    pre(screen().some(line => line.includes('TARGET-')), 'part of target must actually be visible in parsed xterm')
    pre(box.scrollAnchor === undefined, 'initial anchor must be absent')
    const bottomScreen = screen().slice(0, VIEWPORT), before = sample('ready')
    if (name === 'bottom-noop') {
      h.scrollBy(1)
      const immediate = sample('after-down')
      const noOp = immediate.top === before.top && immediate.sticky === true &&
        immediate.intent === before.intent && immediate.pendingDelta === 0 && !immediate.anchorPresent && immediate.frame === before.frame
      const mark = frame; revision++; app.rerender(tree())
      await when('independent positive-control frame', () => frame > mark && parsed() && screen().some(line => line.includes(`FOOTER-${revision}`)))
      const after = sample('redraw')
      const sameViewport = JSON.stringify(screen().slice(0, VIEWPORT)) === JSON.stringify(bottomScreen)
      pre(frameSamplesDropped === 0, 'positive-control frame observations must not overflow')
      const afterFrames = frameSamples.filter(f => f.frame > before.frame)
      const noJitter = afterFrames.length > 0 && afterFrames.every(f => f.top === f.max && f.sticky === true) && sameViewport
      reports.push({ name, noOp, noJitter, before, immediate, after, afterFrames })
      assert.ok(noOp && noJitter, 'bottom overscroll must be a zero-jitter no-op')
      assert.deepEqual(intents, ['first'], 'bottom overscroll reports the explicit intent once')
      onScrollByIntent = secondIntent
      const mark3 = frame; revision++; app.rerender(tree())
      await when('updated intent callback committed', () => frame > mark3 && parsed() && screen().some(line => line.includes(`FOOTER-${revision}`)))
      h.scrollBy(1)
      assert.deepEqual(intents, ['first', 'second'], 'existing handle uses the latest committed callback')
      const mark4 = frame
      h.scrollBy(0)
      assert.deepEqual(intents, ['first', 'second'], 'zero scroll does not report an intent')
      await when('zero scroll render drained', () => frame > mark4 && parsed())
      await app.unmount(); app = undefined
      h.scrollBy(1)
      assert.deepEqual(intents, ['first', 'second'], 'detached handle must not report an intent')
    } else if (name === 'up-control') {
      const mark = frame
      h.scrollBy(-1)
      await when('negative-control new frame', () => frame > mark && parsed())
      const after = sample('up-rendered')
      reports.push({ name, before, after })
      assert.ok(after.top !== undefined && after.max !== undefined && after.top < after.max && after.sticky === false,
        'up-scroll at bottom must leave the bottom')
    } else {
      const mark = frame
      h.scrollToElement(el, 0, true, true)
      h.scrollBy(1) // same synchronous input batch; no intervening await or render
      const immediate = sample('after-seek-and-down')
      await when('actual seek/down frame', () => frame > mark && parsed())
      const first = sample('first-new-frame')
      const mark2 = frame; revision++; app.rerender(tree())
      await when('independent later frame', () => frame > mark2 && parsed() && screen().some(line => line.includes(`FOOTER-${revision}`)))
      const later = sample('later-new-frame')
      const bottomVisible = screen().some(line => line.includes('TAIL-4'))
      pre(frameSamplesDropped === 0, 'seek frame observations must not overflow')
      const afterFrames = frameSamples.filter(f => f.frame > mark)
      reports.push({ name, before, immediate, first, later, bottomVisible, afterFrames })
      assert.ok(afterFrames.length >= 2 && afterFrames.every(f => f.top === f.max && !f.anchorPresent) &&
        first.top === first.max && later.top === later.max && !first.anchorPresent && !later.anchorPresent && bottomVisible,
        'down input must cancel old held anchor: both genuine frames stay at bottom without anchor')
    }
  } finally {
    try {
      await app?.unmount()
      await when('terminal writes drained after unmount', parsed)
    } finally {
      input.destroy(); out.destroy(); err.destroy(); term.dispose(); closeSync(fd)
    }
    if (ttyOverflow) throw new Error(`fake TTY output exceeded ${ttyLimit} bytes`)
  }
}
for (const name of ['bottom-noop', 'up-control', 'seek-then-down'] as const) {
  try { await scenario(name); console.log(`PASS ${name}`) }
  catch (error) {
    if (error instanceof PrerequisiteError) { prerequisites++; console.error(`PREREQUISITE ${name}: ${error.message}`) }
    else { failures++; console.error(`FAIL ${name}: ${String(error)}`) }
    reports.push({ name, error: String(error), prerequisite: error instanceof PrerequisiteError })
  }
}
if (dropped > 0) { failures++; console.error(`FAIL diagnostic event overflow: ${dropped}`) }
console.log(JSON.stringify({ failures, prerequisites, dropped, reports }))
process.exitCode = failures ? 1 : prerequisites ? 2 : 0
