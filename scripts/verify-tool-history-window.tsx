/**
 * Tool-heavy streaming: bounded mount windows and stable settled-row props.
 * Run: node --import tsx/esm scripts/verify-tool-history-window.tsx
 */
import './lib/fake-home.mjs'
import '../src/force-production-react.js'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import type { ScrollBoxHandle } from '../src/ui.js'
import type { ChatRow } from '../src/dsh-adapter/channel.js'
import type { DOMElement } from '../src/ink/dom.js'
import { settled } from './lib/term-test.mjs'

const [React, { AlternateScreen, Box, render, ScrollBox, Text }, { MessageList }, { Chat }, { QuestionStore }, { nodeCache }] = await Promise.all([
  import('react'), import('../src/ui.js'), import('../src/components/MessageList.js'),
  import('../src/screens/Chat.js'), import('../src/dsh-adapter/questions.js'), import('../src/ink/node-cache.js'),
])

class Input extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class Sink extends Writable {
  isTTY = true
  columns = 80
  rows = 24
  _write(_chunk: unknown, _encoding: BufferEncoding, done: () => void) { done() }
}

for (const fullscreen of [true, false]) {
  const rows: ChatRow[] = Array.from({ length: 120 }, (_, i) => ({
    id: i + 1, kind: 'tool', text: '',
    tool: {
      callId: `call-${i}`, name: 'Read', argsText: `module-${i}.ts`,
      status: i === 0 ? 'error' : 'ok', startedAt: 0, durationMs: 10,
      resultText: `source ${i}\nmore source ${i}`, errorText: i === 0 ? 'earlier failure' : undefined,
    },
  }))
  const mounted = new Map<number, DOMElement>()
  const painted = new Set<number>()
  const registerRowRef = (id: number, el: DOMElement | null) => {
    if (el) mounted.set(id, el)
    else mounted.delete(id)
  }
  let handle: ScrollBoxHandle | null = null
  let latestFrame: number[] = []
  let frameCount = 0
  let seekTarget: DOMElement | undefined
  let seekPaint: { frame: number; target: DOMElement; y: number; height: number; viewportTop: number; viewportHeight: number; scrollTop: number; yogaTop: number } | undefined
  let revision = 0
  let hintRow = 1
  let forced: number | null = null
  const expandedRows = new Set<number>()
  const noop = () => {}
  function Harness() {
    const [scroll, setScroll] = React.useState<ScrollBoxHandle | null>(null)
    handle = scroll
    const content = <Box flexDirection="column">
      <ScrollBox ref={setScroll} height={fullscreen ? 20 : undefined} stickyScroll flexDirection="column">
        <MessageList rows={rows} expanded={false} expandedRows={expandedRows} selectedId={null}
          onToggleRow={noop} model="test" showAll onToggleAll={noop}
          historyPaintEnabled={!fullscreen} registerRowRef={registerRowRef} scrollHandle={scroll}
          failureHintRowId={hintRow} failureHint="See full trajectory" forceMountRowId={forced} />
      </ScrollBox>
      <Text>INPUT-READY {revision}</Text>
    </Box>
    return fullscreen ? <AlternateScreen>{content}</AlternateScreen> : content
  }
  const stdout = new Sink()
  const app = await render(<Harness />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    stderr: new Sink() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: () => {
      latestFrame = [...mounted.keys()]
      for (const id of latestFrame) painted.add(id)
      frameCount++
      const scroll = handle as ScrollBoxHandle | null
      const target = seekTarget
      if (scroll !== null && target !== undefined && mounted.get(1) === target) {
        const rect = nodeCache.get(target)
        const yogaTop = target.yogaNode?.getComputedTop()
        if (rect !== undefined && yogaTop !== undefined) {
          seekPaint = { frame: frameCount, target, y: rect.y, height: rect.height,
            viewportTop: scroll.getViewportTop(), viewportHeight: scroll.getViewportHeight(),
            scrollTop: scroll.getScrollTop(), yogaTop }
        }
      }
    },
  })
  try {
    if (!fullscreen) {
      // Inline history must first reach scrollback. Then a live update may
      // release the flush hold and tighten the mount window again.
      assert.ok(await settled(() => painted.size === 120), 'inline history must paint before it is unmounted')
      revision++
      app.rerender(<Harness />)
    }
    assert.ok(await settled(() => latestFrame.includes(120) && latestFrame.length < 30),
      `${fullscreen ? 'fullscreen' : 'inline'}: historical failure pinned ${latestFrame.length} tool cards`)
    assert.ok(!latestFrame.includes(1), 'an offscreen footnote is not a force-mount request')
    if (!fullscreen) continue // Inline history uses the terminal's native scrollback.
    // Explicit seeking still mounts its target. The hint is preserved when
    // the user returns to that card, rather than deleted to reduce work.
    forced = 1
    app.rerender(<Harness />)
    assert.ok(await settled(() => latestFrame.includes(1)))
    const first = mounted.get(1)!
    seekTarget = first
    const frameBeforeSeek = frameCount
    handle!.scrollToElement(first)
    assert.ok(await settled(() => !handle!.isSticky()))
    // isSticky flips synchronously, before a render can consume the anchor.
    // Require a new paint with the same target at the actual viewport top.
    assert.ok(await settled(() => {
      const sample = seekPaint
      return sample !== undefined && sample.frame > frameBeforeSeek && sample.frame === frameCount && sample.target === first &&
        mounted.get(1) === first && latestFrame.includes(1) && sample.height > 0 && sample.viewportHeight > 0 &&
        Math.abs(sample.y - sample.viewportTop) <= 1 && Math.abs(sample.scrollTop - sample.yogaTop) <= 1
    }), `seek did not land in a new painted frame: ${JSON.stringify(seekPaint && { ...seekPaint, target: '<target>' })}`)
    forced = null
    app.rerender(<Harness />)
    assert.ok(await settled(() => latestFrame.includes(1) && latestFrame.length < 30))
    // A later failure and a streaming tail must not widen the historical
    // window either. The current viewport remains bounded while reading.
    hintRow = 119
    rows[118]!.tool!.status = 'error'
    rows.push({ id: 121, kind: 'assistant', text: 'new streamed text', streaming: true })
    const before = frameCount
    app.rerender(<Harness />)
    assert.ok(await settled(() => frameCount > before && latestFrame.includes(1) && latestFrame.length < 30),
      `streaming widened the historical window: ${latestFrame.length} cards`)
  } finally {
    await app.unmount()
  }
}

// Exercise the real Chat -> MessageList prop chain as well. Unstable open
// callbacks used to invalidate EVERY MemoRow on each channel version,
// re-reading even collapsed settled tool results while only the tail grew.
{
  let resultReads = 0
  let lastReadAt = 0
  const resultView = () => ({
    card: 'terminal' as const,
    get output() {
      resultReads++
      lastReadAt = Date.now()
      return 'settled tool output\n'.repeat(1_000)
    },
  })
  const tool: ChatRow = {
    id: 1, kind: 'tool', text: '', tool: {
      callId: 'done', name: 'Bash', argsText: 'build', status: 'ok', startedAt: 0,
      resultView: resultView(),
    },
  }
  const tail: ChatRow = { id: 2, kind: 'assistant', text: 'LIVE', streaming: true }
  const listeners = new Set<() => void>()
  const channel = {
    version: 0, rows: [tool, tail], agentId: 'memo-probe', status: 'idle', working: false,
    whale: false, whaleIdle: false, model: 'test', provider: 'test', reasoningEffort: 'high',
    tokens: { input: 0, output: 0 }, cwd: '/tmp', displayCwd: '/tmp', gitBranch: 'main',
    spinnerMode: 'responding', responseChars: 0, activeToolCount: 0, turnStart: 0,
    pending: [], notifications: [], commandList: [], mode: { plan: false }, subagents: [],
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    submit() {}, cancel() {}, clear() {}, notify() {}, loadOlder() {}, setResumeTarget() {},
    listModels: async () => [], listSessions: async () => [], mcpStatus: () => [],
  }
  let frameCount = 0
  const stdout = new Sink()
  const app = await render(<AlternateScreen>
    <Chat channel={channel as never} questionStore={new QuestionStore()} fullscreen trajectorySeen />
  </AlternateScreen>, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    stderr: new Sink() as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false,
    onFrame: () => { frameCount++ },
  })
  try {
    assert.ok(await settled(() => resultReads > 0 && frameCount > 0 && Date.now() - lastReadAt >= 100))
    const historicalReads = resultReads
    for (let i = 0; i < 5; i++) {
      const before = frameCount
      tail.text += '.'
      channel.version++
      for (const listener of listeners) listener()
      assert.ok(await settled(() => frameCount > before))
    }
    assert.equal(resultReads, historicalReads, 'streaming must not re-render the unchanged settled tool card')
    tool.tool!.resultView = resultView()
    channel.version++
    for (const listener of listeners) listener()
    assert.ok(await settled(() => resultReads > historicalReads), 'an actual result update still re-renders the card')
  } finally {
    await app.unmount()
  }
}

console.log('tool history passed (bounded windows, seek, streaming row memo, inline and fullscreen)')
