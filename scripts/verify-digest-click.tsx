/**
 * A collapsed history chunk paints ONE digest line. That line is the load
 * control for its chunk: clicking it calls `onRevealCollapsed(rowId)` so the
 * chunk is projected in place. Before this the only way to read old history
 * was to scroll to the very top and press the "load earlier" pager, then find
 * the place again — the reported rail-era annoyance.
 *
 * A plain `notice` divider (compact summary, no `collapsed` flag) must stay
 * inert: it carries no loadable region.
 *
 * Mouse hit-testing, the row's click handler and the divider chrome are all
 * production code; only the channel call is a spy.
 *
 * Run: node --import tsx/esm scripts/verify-digest-click.tsx
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

const ROWS_N = 200
const DIGEST_ID = 199
const DIGEST_TURNS = [
  { id: -2_000_001, seq: 900_001, text: 'OLD-PROMPT-1', imageCount: 0 },
  { id: -2_000_002, seq: 900_002, text: 'OLD-PROMPT-2', imageCount: 0 },
]
const PLAIN_NOTICE_ID = 198

const rows: ChatRow[] = Array.from({ length: ROWS_N }, (_, i): ChatRow => {
  const id = i + 1
  if (id === DIGEST_ID) {
    return {
      id,
      kind: 'notice',
      text: '3 earlier turns',
      collapsed: true,
      collapsedTurns: DIGEST_TURNS,
      restored: true,
    }
  }
  if (id === PLAIN_NOTICE_ID) return { id, kind: 'notice', text: 'session compacted' }
  if (id % 4 === 0) return { id, kind: 'user', text: `turn ${id / 4}` }
  return {
    id, kind: 'tool', text: '',
    tool: {
      callId: `call-${id}`, name: 'Read', argsText: `module-${id}.ts`,
      status: 'ok', startedAt: 0, durationMs: 5,
      resultText: `source ${id} first\nsource ${id} second`,
    },
  }
})

let handle: ScrollBoxHandle | null = null
const mounted = new Map<number, DOMElement>()
const expandedRows = new Set<number>()
const revealed: number[] = []
const noop = (): void => {}
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
        onToggleRow={noop} model="test" showAll={false} onToggleAll={noop}
        onRevealCollapsed={(id: number) => { revealed.push(id) }}
        registerRowRef={registerRowRef} scrollHandle={scroll} />
    </ScrollBox>
  </Box>
}

const stdout = new Sink()
const app = await render(<Harness />, {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stdin: new Input() as unknown as NodeJS.ReadStream,
  stderr: new Sink() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false, patchConsole: false,
})
try {
  assert.ok(await settled(() => handle !== null && mounted.has(DIGEST_ID) && mounted.has(PLAIN_NOTICE_ID)),
    'the tail window must mount both dividers')

  const { dispatchClick } = await import('../src/ink/hit-test.js')
  const { default: inkInstances } = await import('../src/ink/instances.js')
  const rootNode = (inkInstances.get(stdout as never) as unknown as { rootNode?: DOMElement } | undefined)?.rootNode
  assert.ok(rootNode !== undefined, 'the ink root must exist')

  const digest = mounted.get(DIGEST_ID)!
  const rect = nodeCache.get(digest)
  assert.ok(rect !== undefined, 'the digest line must have a laid-out rect')
  // Hit-testing reads root-space geometry, so no terminal is needed. Click the
  // divider's own line, one column in; a blank gutter cell would be ignored by
  // the fold handlers, but this row's load control has no blank guard.
  // 固定窗:pacing 吸底尾巴挂载后仍在测量行高，没有单一可轮询的落定锚点
  await sleep(200)
  const topBefore = handle!.getScrollTop()
  const hit = dispatchClick(rootNode!, rect!.x + 2, rect!.y)
  assert.equal(hit, true, 'the digest line must consume the click')
  assert.deepEqual(revealed, [DIGEST_ID], 'the click must project exactly the clicked chunk')

  const plain = mounted.get(PLAIN_NOTICE_ID)!
  const plainRect = nodeCache.get(plain)
  assert.ok(plainRect !== undefined)
  const plainHit = dispatchClick(rootNode!, plainRect!.x + 2, plainRect!.y)
  assert.equal(plainHit, false, 'a plain notice divider must not be clickable')
  assert.deepEqual(revealed, [DIGEST_ID], 'a plain notice must not request a load')

  // The click must not have moved the reader: the digest loads in place.
  await sleep(200) // 固定窗:探针 let any post-click re-anchor pass run
  assert.equal(handle!.getScrollTop(), topBefore, 'projecting a chunk in place must not scroll the reader')
  console.log('PASS: digest line projects its chunk on click; plain notices stay inert')
} finally {
  await app.unmount()
}
