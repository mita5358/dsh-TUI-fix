/**
 * Chunked-history rail through the real DSH channel, immutable UI mount and
 * fullscreen Chat/xterm. No credentials, disk transcript or production profile.
 * Large ask_user_question arguments force chunks but never paint large cards.
 * Run: node --import tsx/esm scripts/verify-chunked-rail.tsx
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

const scratchPrefix = join(tmpdir(), 'dsh-chunked-rail-')
const scratch = mkdtempSync(scratchPrefix)
const environment = ['HOME', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'FORCE_COLOR', 'DSH_TUI_THEME', 'DSH_TUI_LANG'] as const
const previousEnvironment = new Map(environment.map(key => [key, process.env[key]]))
process.env.HOME = join(scratch, 'home')
process.env.DSH_HOME = join(scratch, 'dsh-home')
process.env.XDG_CONFIG_HOME = join(scratch, 'config')
process.env.XDG_CACHE_HOME = join(scratch, 'cache')
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
mkdirSync(process.env.HOME, { recursive: true })

const [React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel }, { mountChannelUi }, { registerTuiChannel }, { bindChannelCommands }, { settled, sleep }, { t }] = await Promise.all([
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel-ui.js'),
  import('../src/adapter/channel/host-registry.js'),
  import('../src/dsh-adapter/channel/commands.js'),
  import('./lib/term-test.mjs'),
  import('../src/i18n.js'),
])

const { default: inkInstances } = await import('../src/ink/instances.js')
type ProbeNode = {
  nodeName?: string
  nodeValue?: string
  childNodes?: ProbeNode[]
  yogaNode?: { getComputedTop(): number; getComputedHeight(): number }
  scrollTop?: number
  scrollHeight?: number
  scrollViewportHeight?: number
  scrollViewportTop?: number
  stickyScroll?: boolean
  scrollAnchor?: { el: ProbeNode; offset: number }
  scrollClampMin?: number
  scrollClampMax?: number
}
type RawEvent = { type: string; seq: number; time: number; data: Record<string, unknown> }
const events: RawEvent[] = []
const humanSeqs: number[] = []
const append = (type: string, data: Record<string, unknown>): RawEvent => {
  const event = { type, seq: events.length + 1, time: events.length + 1, data }
  events.push(event)
  return event
}
const human = (number: number, imageOnly = false): RawEvent => append('user/message', {
  id: `human-${number}`, source: { kind: 'user' },
  content: imageOnly
    ? [{ type: 'image', attachment: { attachmentId: 'rail-image', mediaType: 'image/png', width: 1, height: 1, name: 'rail.png' } }]
    : [{ type: 'text', text: `RAIL-PROMPT-${number}` }],
})
for (let number = 1; number <= 12; number += 1) {
  humanSeqs.push(human(number, number === 2).seq)
  // Interleaved hidden inputs must not turn into phantom human ticks.
  append('user/message', { id: `hidden-${number}`, source: { kind: 'plugin', plugin: 'rail-test' }, content: [{ type: 'text', text: `HIDDEN-${number}` }] })
  if (number === 3) {
    append('user/message', { id: 'team-input', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'peer' }, content: [{ type: 'text', text: 'Team message from peer:' }, { type: 'text', text: 'NONHUMAN-TEAM' }] })
    append('user/message', { id: 'compact-input', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'NONHUMAN-COMPACT' }] })
  }
  if (number < 12) append('tool/call', { turn: number, step: 1, callId: `weight-${number}`, name: 'ask_user_question', arguments: JSON.stringify({ unused: 'x'.repeat(300_000) }) })
  // A settled tool card with a many-line result: revealed chunks must paint
  // it as a one-line digest (`… +N 行`) and spend the full body only on click.
  const toolBody = Array.from({ length: 12 }, (_, line) => `TOOLOUT-${number}-${line + 1}`).join('\n')
  append('tool/call', { turn: number, step: 2, callId: `body-${number}`, name: 'bash', arguments: JSON.stringify({ command: `run-${number}` }) })
  append('tool/result', { turn: number, step: 2, callId: `body-${number}`, message: { role: 'tool', source: { callId: `body-${number}` }, content: [{ type: 'text', text: toolBody }] } })
  // A fenced block per answer: revealed chunks must paint it as a one-row
  // digest (`⌁ ts · N 行 · <first line> …`), not as its body.
  const fence = ['```ts', `const marker${number} = ${number}`, ...Array.from({ length: 24 }, (_, line) => `  // body-${number}-${line + 2}`), '```']
  // Eight prose lines keep the whole turn on one screen: a taller answer
  // pushes the fence digest past the viewport and the click probe would have
  // nothing to hit once the tool card expands above it.
  const otherFence = ['~~~py', `other_marker_${number}`, `other_body_${number}`, '~~~']
  const answer = Array.from({ length: 8 }, (_, line) => `RAIL-ANSWER-${number} line ${line + 1}`).concat(otherFence, fence).join('\n')
  append('assistant/message', { turn: number, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
}

// Same shape, seqs, ids and string lengths, but a different conversation's prompts.
const replacementEvents: RawEvent[] = structuredClone(events)
for (const event of replacementEvents) {
  if (event.type !== 'user/message' || !Array.isArray(event.data.content)) continue
  for (const block of event.data.content as { type?: string; text?: string }[]) {
    if (block.type === 'text' && block.text?.startsWith('RAIL-PROMPT-')) block.text = block.text.replace('RAIL-', 'SWAP-')
  }
}

const callbacks = new Map<string, Set<(...args: unknown[]) => unknown>>()
const effectCleanups: (() => void)[] = []
let creates = 0
const createAgent = (id: string, record: RawEvent[]) => ({
  id, status: 'idle',
  session: { id: `${id}-session`, seq: record.at(-1)?.seq ?? 0, events: record, header: { cwd: scratch } },
  ctx: { on: () => () => undefined },
  followup() {}, steer() {}, cancel() {}, inbox: { remove: () => true },
})
const agent = createAgent('chunked-rail', events)
const services: Record<string, unknown> = {
  settings: { describe: () => [{ ns: 'llm-pi-ai', revision: 1, user: {}, value: {} }, { ns: 'dsh-tui', revision: 1, user: {}, value: { recapOnOpen: false } }], get: () => ({}), mutate: async () => undefined },
  credentials: { resolve: async () => undefined, set: async () => undefined, unset: async () => undefined },
  llm: { listConfigurableProviders: () => [], discoverModels: async () => [] },
  agents: {
    create: async () => ({ agent: createAgent(`new-rail-${++creates}`, []), dispose: async () => undefined }),
    resume: async () => ({ agent: createAgent('swap-rail', replacementEvents), dispose: async () => undefined }),
  },
}
const ctx = {
  on(name: string, listener: (...args: unknown[]) => unknown) {
    const listeners = callbacks.get(name) ?? new Set()
    listeners.add(listener)
    callbacks.set(name, listeners)
    return () => { listeners.delete(listener) }
  },
  effect(setup: () => () => void) { effectCleanups.push(setup()) },
  get(name: string) { return services[name] },
  logger: { warn() {} },
}
const raw = createChannel(ctx as never, agent as never, {
  model: 'model', provider: 'provider', cwd: scratch, activity: false,
  whale: false, whaleIdle: false, minimalUi: true, smoothStreaming: false,
})
const unregister = registerTuiChannel(ctx, raw)
const mount = mountChannelUi(ctx, raw, undefined, 'new')
let revealSyncMs = 0
const measuredChannel = new Proxy(mount.channel, {
  get(target, property) {
    const value = Reflect.get(target, property, target)
    if (property !== 'revealRow' || typeof value !== 'function') return value
    return (rowId: number) => {
      const startedAt = performance.now()
      try { return value(rowId) }
      finally { revealSyncMs += performance.now() - startedAt }
    }
  },
})
bindChannelCommands(raw, mount.channel)

const COLS = 100
const ROWS = 40
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
let debugTargetText = ''
let debugFrames = 0
let pendingFrames = 0
// 点按行号是从 xterm 缓冲区读的，而帧是异步解析的：在解析中途读会拿到半帧
// （整片空白 + 已经画好的后半行），按那个行号点下去必然点到邻行。等队列排空再读。
const drained = async (): Promise<void> => {
  for (let round = 0; round < 400; round += 1) {
    if (pendingFrames === 0) return
    await sleep(5)  // 固定窗:pacing 等 xterm 解析队列排空；没有可轮询的解析完成信号
  }
}
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, done: () => void) {
    pendingFrames += 1
    term.write(String(chunk), () => {
      pendingFrames -= 1
      if (process.env.DSH_TUI_CHUNKED_RAIL_DEBUG === '1' && debugTargetText !== '' && debugFrames < 10) {
        debugFrames += 1
        debugGeometry(debugTargetText, `frame-${debugFrames}`)
      }
      done()
    })
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdout = new FakeStdout()
const stdin = new FakeStdin()
const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
const screenLines = (): string[] => {
  const buffer = term.buffer.active
  return Array.from({ length: ROWS }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')
}
const railTicks = (): number[] => {
  const buffer = term.buffer.active
  const ticks: number[] = []
  for (let row = 0; row < ROWS; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)
    const glyphs = (line?.getCell(COLS - 2)?.getChars() ?? '') + (line?.getCell(COLS - 1)?.getChars() ?? '')
    if (glyphs === '━━' || glyphs === '──' || glyphs === ' ─') ticks.push(row)
  }
  return ticks
}
const scrollNode = (): ProbeNode | undefined => {
  const ink = inkInstances.get(stdout as never) as unknown as { rootNode?: ProbeNode } | undefined
  const walk = (node: ProbeNode): ProbeNode | undefined => {
    if (node.scrollViewportHeight !== undefined) return node
    for (const child of node.childNodes ?? []) {
      const found = walk(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  return ink?.rootNode === undefined ? undefined : walk(ink.rootNode)
}
const promptAtViewportTop = (text: string, ordinal: number): boolean => {
  const top = scrollNode()?.scrollViewportTop ?? 0
  const ticks = railTicks()
  const activeRow = ticks.findIndex(row => {
    const line = term.buffer.active.getLine(term.buffer.active.baseY + row)
    return line?.getCell(COLS - 2)?.getChars() === '━' && line?.getCell(COLS - 1)?.getChars() === '━'
  })
  // The transcript keeps a fixed 1-row pinned header above the ScrollBox: the
  // reading turn's prompt moves there as soon as its own row scrolls out, so
  // "the prompt is at the top" covers that header row AND the first scrolled
  // lines. activeRow still pins the turn identity via the rail highlight.
  return activeRow === ordinal && screenLines().slice(Math.max(0, top - 1), top + 2).some(line => line.includes(text))
}
const debugGeometry = (text: string, phase = 'settled'): void => {
  const ink = inkInstances.get(stdout as never) as unknown as { rootNode?: ProbeNode } | undefined
  const state: Record<string, unknown> = { phase, target: text, mountedTarget: false, textPath: [] }
  const walk = (node: ProbeNode, path: ProbeNode[]): void => {
    if (node.scrollViewportHeight !== undefined) Object.assign(state, {
      top: node.scrollTop, height: node.scrollHeight, viewport: node.scrollViewportHeight,
      viewportTop: node.scrollViewportTop, sticky: node.stickyScroll,
      anchorTop: node.scrollAnchor?.el.yogaNode?.getComputedTop(), anchorOffset: node.scrollAnchor?.offset,
      clampMin: node.scrollClampMin, clampMax: node.scrollClampMax,
    })
    if (node.nodeValue === text) {
      state.mountedTarget = true
      state.textPath = path.slice(-4).map(parent => ({ name: parent.nodeName, top: parent.yogaNode?.getComputedTop(), height: parent.yogaNode?.getComputedHeight() }))
    }
    for (const child of node.childNodes ?? []) walk(child, [...path, node])
  }
  if (ink?.rootNode) walk(ink.rootNode, [])
  console.error(`RAIL-TRACE ${JSON.stringify(state)}`)
}
const traceAnchorAssignments = (): void => {
  const node = scrollNode()
  if (node === undefined) return
  let value = node.scrollAnchor
  Object.defineProperty(node, 'scrollAnchor', {
    configurable: true, enumerable: true,
    get() { return value },
    set(next: ProbeNode['scrollAnchor']) {
      value = next
      if (debugFrames < 10) debugGeometry(debugTargetText, next === undefined ? 'anchor-cleared' : 'anchor-assigned')
    },
  })
}
const summaries = () => mount.channel.rows.filter(row => row.collapsed === true)
const indexedTurns = () => mount.channel.rows.flatMap(row => row.collapsedTurns ?? [])
const visibleHumanRows = () => mount.channel.rows.filter(row => row.kind === 'user' && row.label !== 'team-message')
const allTurnCount = () => indexedTurns().length + visibleHumanRows().length
const isAtBottom = (): boolean => {
  const node = scrollNode()
  return node !== undefined && node.stickyScroll === true && node.scrollTop === Math.max(0, (node.scrollHeight ?? 0) - (node.scrollViewportHeight ?? 0))
}
const emitLive = (type: string, data: Record<string, unknown>): RawEvent => {
  const event = append(type, data)
  agent.session.seq = event.seq
  for (const callback of callbacks.get('session/event') ?? []) callback(agent.session, event)
  return event
}
let passed = 0
let failed = 0
const check = (name: string, ok: unknown): void => {
  if (ok) {
    passed += 1
    console.log(`PASS: ${name}`)
  } else {
    failed += 1
    console.error(`FAIL: ${name}\n${screenLines().join('\n')}`)
  }
}
let app: Awaited<ReturnType<typeof render>> | undefined
let navigationStartedAt: number | null = null
const navigationFrames: Array<{ durationMs: number; commitMs: number; yogaMs: number; yogaVisited: number; yogaMeasured: number }> = []
try {
  const initialSummaries = summaries()
  check('real raw replay plans multiple old chunks', initialSummaries.length >= 3)
  check('old chunks paint one notice each, never fake user rows', initialSummaries.every(row => row.kind === 'notice') && visibleHumanRows().length === 1)
  const indexedSeqs = [...indexedTurns().map(turn => turn.seq), ...visibleHumanRows().map(row => row.seq)].sort((a, b) => (a ?? 0) - (b ?? 0))
  check('initial complete rail index contains exactly the human seqs, not injected/team/compaction inputs', allTurnCount() === 12 && JSON.stringify(indexedSeqs) === JSON.stringify(humanSeqs))
  check('image-only human is indexed exactly once', indexedTurns().filter(turn => turn.seq === humanSeqs[1] && turn.text === '' && turn.imageCount === 1).length === 1)
  check('production UI mount freezes nested navigation metadata', Object.isFrozen(initialSummaries[0]?.collapsedTurns) && Object.isFrozen(initialSummaries[0]?.collapsedTurns?.[0]))
  const targetSummary = initialSummaries[Math.floor(initialSummaries.length / 2)]!
  const target = targetSummary.collapsedTurns?.[1]
  assert.ok(target, 'middle old chunk must contain a non-first human prompt')
  const targetNumber = humanSeqs.indexOf(target.seq) + 1
  const originalHandles = indexedTurns().map(turn => turn.id)
  const unchangedSummaries = initialSummaries.filter(row => row.id !== targetSummary.id).map(row => row.id)
  const targetOrdinal = humanSeqs.indexOf(target.seq)

  app = await render(
    <AlternateScreen><Chat channel={measuredChannel} questionStore={new QuestionStore()} fullscreen trajectorySeen /></AlternateScreen>,
    { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, patchConsole: false, exitOnCtrlC: false,
      onFrame: frame => {
        if (navigationStartedAt !== null) navigationFrames.push({
          durationMs: frame.durationMs,
          commitMs: frame.phases.commit ?? 0,
          yogaMs: frame.phases.yoga ?? 0,
          yogaVisited: frame.phases.yogaVisited ?? 0,
          yogaMeasured: frame.phases.yogaMeasured ?? 0,
        })
      },
    },
  )
  check('first rendered rail has 12 ticks, not only the newest prompt', await settled(() => railTicks().length === 12))
  check('render alone does not eagerly materialize old chunks', summaries().length === initialSummaries.length)
  const imageTickRow = railTicks()[1]
  assert.notEqual(imageTickRow, undefined)
  stdin.write(`\x1b[<35;${COLS};${imageTickRow! + 1}M`)
  check('unloaded image-only tick previews its localized image label', await settled(() => screenLines().some(line => line.includes(t('transcript-image-message', { count: 1 })))))
  const previewTickRow = railTicks()[targetOrdinal]
  assert.notEqual(previewTickRow, undefined)
  stdin.write(`\x1b[<35;${COLS};${previewTickRow! + 1}M`)
  check('unloaded old prompt preview comes from the full index', await settled(() => screenLines().some(line => line.includes(`RAIL-PROMPT-${targetNumber}`))))
  check('hover previews alone do not load their chunks', summaries().length === initialSummaries.length)

  // Mouse hit-testing and Chat.revealAndSeekRow are production code, not a fake reveal.
  const tickRow = railTicks()[targetOrdinal]
  assert.notEqual(tickRow, undefined)
  if (process.env.DSH_TUI_CHUNKED_RAIL_DEBUG === '1') {
    debugTargetText = `RAIL-PROMPT-${targetNumber}`
    traceAnchorAssignments()
    debugGeometry(debugTargetText, 'before-click')
  }
  const rowCountBeforeClick = mount.channel.rows.length
  const stickyBeforeClick = scrollNode()?.stickyScroll === true
  revealSyncMs = 0
  navigationFrames.length = 0
  navigationStartedAt = performance.now()
  stdin.write(`\x1b[<0;${COLS};${tickRow! + 1}M`)
  stdin.write(`\x1b[<0;${COLS};${tickRow! + 1}m`)
  const targetMaterialized = await settled(() => !summaries().some(row => row.id === targetSummary.id), { stepMs: 1 })
  const clickToMaterializeMs = performance.now() - navigationStartedAt
  check('clicking non-first prompt materializes its owning old chunk', targetMaterialized)
  check('click reveals only that chunk, leaves both sides collapsed', summaries().length === initialSummaries.length - 1 && unchangedSummaries.every(id => summaries().some(row => row.id === id)))
  const targetSeekSettled = await settled(() => promptAtViewportTop(`RAIL-PROMPT-${targetNumber}`, targetOrdinal), { stepMs: 1 })
  const clickToSeekSettledMs = performance.now() - navigationStartedAt
  navigationStartedAt = null
  check('clicked prompt, not the chunk heading/first prompt, reaches the viewport top', targetSeekSettled)
  console.log(`CHUNKED_RAIL_NAV_TIMING ${JSON.stringify({
    rowsBefore: rowCountBeforeClick,
    rowsAfter: mount.channel.rows.length,
    chunkRows: mount.channel.rows.length - rowCountBeforeClick + 1,
    stickyBeforeClick,
    revealSyncMs: Number(revealSyncMs.toFixed(2)),
    clickToMaterializeMs: Number(clickToMaterializeMs.toFixed(2)),
    clickToSeekSettledMs: Number(clickToSeekSettledMs.toFixed(2)),
    frames: navigationFrames,
  })}`)
  // 固定窗:探针 measured prefix/chrome updates must not dislodge a completed seek.
  await sleep(200)
  check('exact prompt stays anchored after post-seek measurement settles', promptAtViewportTop(`RAIL-PROMPT-${targetNumber}`, targetOrdinal))
  // 折叠默认值（用户反馈）:历史块的代码围栏只留一行摘要，正文不出现在屏上；
  // Ctrl+O（全局展开）能把同一行展开成完整围栏，再按一次收回。
  const fenceDigest = (): boolean => screenLines().some(line => line.includes('⌁ ts ·') && line.includes(`const marker${targetNumber}`) && line.includes('点击展开'))
  check('revealed chunk paints a one-row code fence digest', await settled(fenceDigest))
  check('revealed chunk does not paint the fence body by default', !screenLines().some(line => line.includes(`body-${targetNumber}-2`)))
  stdin.write('\x0f')
  check('Ctrl+O expands the folded fence to its body', await settled(() => screenLines().some(line => line.includes(`other_body_${targetNumber}`))))
  stdin.write('\x0f')
  check('Ctrl+O again folds the fence back to its digest', await settled(() => fenceDigest() && !screenLines().some(line => line.includes(`body-${targetNumber}-2`))))
  // 行点击（用户请求的手势）:摘要行本身就是展开开关，点一下展开、再点收回。
  const digestLine = (): number => screenLines().findIndex(line => line.includes('⌁ ts ·') && line.includes(`const marker${targetNumber}`))
  // 点击前先等这一行的坐标连续两帧不变：seek 的 hold 锚点刚落地时还会再排一两次，
  // 屏上行的 y 会挪，按旧 y 点下去会落到邻行（真机上人眼看稳了才点，不会遇到）。
  const stableRow = async (find: () => number): Promise<number> => {
    let previous = find()
    for (let round = 0; round < 40; round += 1) {
      await drained()
      const current = find()
      if (current >= 0 && current === previous && pendingFrames === 0) return current
      previous = current
    }
    return find()
  }
  const clickFence = (): void => {
    const index = digestLine()
    assert.ok(index >= 0, 'folded fence digest must be on screen to click it')
    stdin.write(`\x1b[<0;8;${index + 1}M`)
    stdin.write(`\x1b[<0;8;${index + 1}m`)
  }
  await stableRow(digestLine)
  clickFence()
  // 点完可能还压着一帧未解析：先排空再断言，避免「已经展开但屏上还没画」被当成没反应。
  await drained()
  check('clicking the fence digest expands it in place', await settled(() => screenLines().some(line => line.includes(`body-${targetNumber}-2`))))
  check('opening one fence leaves the other fence folded', screenLines().some(line => line.includes('⌁ py ·') && line.includes(`other_marker_${targetNumber}`)))
  check('opening one fence does not expose the other body', !screenLines().some(line => line.includes(`other_body_${targetNumber}`)))
  // Expanded fence: the block itself closes it again (same gesture both ways).
  const bodyLine = (): number => screenLines().findIndex(line => line.includes(`body-${targetNumber}-2`))
  assert.ok(bodyLine() >= 0, 'expanded fence body must be on screen to click it')
  // The expanded body starts within a row or two of the digest that was just
  // clicked, so a fold click inside MULTI_CLICK_TIMEOUT_MS at the same column
  // is a double-click (word select) at the input layer, not a second click.
  await sleep(600)
  await drained()
  stdin.write(`\x1b[<0;8;${bodyLine() + 1}M`)
  stdin.write(`\x1b[<0;8;${bodyLine() + 1}m`)
  check('clicking the expanded fence folds it back', await settled(() => fenceDigest() && !screenLines().some(line => line.includes(`body-${targetNumber}-2`))))
  const loadedTarget = mount.channel.rows.find(row => row.kind === 'user' && row.label !== 'team-message' && row.seq === target.seq)
  assert.ok(loadedTarget)
  const beforeStale = mount.channel.rows.length
  const staleResolved = mount.channel.revealRow(target.id)
  console.log(`TARGET expectedPrompt=${targetNumber} seq=${target.seq} virtualId=${target.id} mappedId=${staleResolved} loadedUserId=${loadedTarget.id} loadedUserText=${loadedTarget.text}`)
  if (process.env.DSH_TUI_CHUNKED_RAIL_DEBUG === '1') debugGeometry(`RAIL-PROMPT-${targetNumber}`)
  check('retained pre-load handle resolves exact durable seq after materialization', staleResolved === loadedTarget.id)
  check('stale-handle resolution does not materialize a second chunk', mount.channel.rows.length === beforeStale)
  check('full rail count survives replacing metadata by real user rows', allTurnCount() === 12 && await settled(() => railTicks().length === 12))

  const live = human(13)
  agent.session.seq = live.seq
  for (const callback of callbacks.get('session/event') ?? []) callback(agent.session, live)
  check('real session/event append adds one user/tick, not a replay duplicate', await settled(() => allTurnCount() === 13 && railTicks().length === 13))

  // One parsed input batch creates an old-row seek, then supersedes it with End.
  stdin.write('\x1b[F')
  check('End establishes a settled tail before cancellation probe', await settled(isAtBottom))
  const canceledSummary = summaries().filter(row => (row.collapsedTurns?.length ?? 0) >= 2).at(-1)
  const canceledTarget = canceledSummary?.collapsedTurns?.[1]
  assert.ok(canceledSummary && canceledTarget, 'cancellation probe needs another unloaded chunk')
  // Input-layer multi-click guard: the fence fold click above is <600ms old,
  // so this press would land as the third click of one gesture (word select)
  // instead of a rail jump.
  await sleep(700)
  // Re-sample AFTER the guard wait: `settled(isAtBottom)` only waits for the
  // frame queue, not for the tail's late commits (live call durations) that
  // can still push the rail down a row — a row sampled a commit early is a
  // click on blank gutter, not on the tick.
  const canceledTickRow = railTicks()[humanSeqs.indexOf(canceledTarget.seq)]
  assert.notEqual(canceledTickRow, undefined, 'cancellation probe needs the tick row on screen')
  stdin.write(`\x1b[<0;${COLS};${canceledTickRow! + 1}M`)
  stdin.write(`\x1b[<0;${COLS};${canceledTickRow! + 1}m`)
  stdin.write('\x1b[F')
  check('pending old-chunk click still loads its chunk before End supersedes seek', await settled(() => !summaries().some(row => row.id === canceledSummary.id)))
  check('same-batch End wins over pending old-chunk seek', await settled(isAtBottom))
  // 固定窗:探针 a canceled request must not reclaim the viewport on later measure commits.
  await sleep(200)
  check('canceled seek never pulls the viewport back after End', isAtBottom())

  // The probes above consume the fixture's unloaded chunks (and the digest
  // that survives holds the image-only turn, which has no text to look for),
  // so the dense-tail probe anchors on an already-materialized, off-screen
  // turn instead. What it verifies is unchanged: a historical prompt sought to
  // the viewport top must stay there while a live producer keeps appending.
  const streamingTarget = visibleHumanRows().filter(row => (row.text ?? '') !== '').at(-5)
  assert.ok(streamingTarget, 'streaming probe needs an off-screen loaded text prompt')
  const streamingOrdinal = humanSeqs.indexOf(streamingTarget.seq)
  const streamingPrompt = streamingTarget.text
  assert.ok(streamingOrdinal >= 2, 'dense-tail target must not be the first turn')
  let streamingChunks = 0
  let streamedText = ''
  emitLive('turn/start', { turn: 13 })
  emitLive('step/start', { turn: 13, step: 1 })
  const sendDelta = (): void => {
    streamingChunks += 1
    const text = `DENSE-TAIL-${streamingChunks} `
    streamedText += text
    // Real legacy durable deltas go through DSH translateEvent and the shared
    // streaming reducer; no direct ChatRow mutations or fake stream projector.
    emitLive('assistant/chunk', { turn: 13, step: 1, chunk: { type: 'text-delta', index: 0, text } })
  }
  sendDelta()
  // 固定窗:pacing a dense producer keeps the unrelated tail changing during seek convergence.
  const streamTimer = setInterval(sendDelta, 4)
  try {
    check('dense real session/event stream starts before the old-chunk click', await settled(() => streamingChunks >= 5 && mount.channel.rows.some(row => row.kind === 'assistant' && row.streaming === true && row.text.includes('DENSE-TAIL-'))))
    // The dense producer repaints every 4 ms, so the rail can reflow between
    // this lookup and the event dispatch: a tick click that lands one row off
    // the (moved) gutters does nothing at all. Retry on the LANDING predicate,
    // not on "the view left the bottom" — a mid-stream frame that clamps one
    // row short of max reads as a seek and used to end the loop before the
    // click had done anything. A stale click cannot fake the landing: the
    // predicate needs the target prompt on top with its own tick active.
    let denseLanded = false
    for (let attempt = 0; attempt < 4 && !denseLanded; attempt += 1) {
      if (attempt > 0) await sleep(600)
      const streamingTickRow = railTicks()[streamingOrdinal]
      if (streamingTickRow === undefined) continue
      stdin.write(`\x1b[<0;${COLS};${streamingTickRow + 1}M\x1b[<0;${COLS};${streamingTickRow + 1}m`)
      denseLanded = await settled(() => streamingChunks >= 5 && promptAtViewportTop(streamingPrompt, streamingOrdinal), 900)
    }
    check('old non-first prompt reaches the exact viewport top during a dense live tail', denseLanded)
    const chunksAtSeek = streamingChunks
    // 固定窗:探针 continued tail deltas must neither starve completion nor dislodge the old prompt.
    await sleep(200)
    check('dense producer keeps delivering after the historical seek completes', streamingChunks > chunksAtSeek && mount.channel.rows.some(row => row.kind === 'assistant' && row.streaming === true && row.text.includes('DENSE-TAIL-')))
    const stableAnchored = promptAtViewportTop(streamingPrompt, streamingOrdinal)
    if (!stableAnchored && process.env.DSH_TUI_CHUNKED_RAIL_DEBUG === '1') {
      const node = scrollNode()
      const head = JSON.stringify(screenLines().slice(0, 3).map(line => line.slice(0, 18)))
      console.error(`DRIFT prompt=${JSON.stringify(streamingPrompt)} ordinal=${streamingOrdinal} top=${node?.scrollViewportTop} scrollTop=${node?.scrollTop} h=${node?.scrollHeight} head=${head}`)
    }
    check('historical prompt stays precisely anchored while the tail continues streaming', stableAnchored)
  } finally {
    clearInterval(streamTimer)
    emitLive('assistant/message', { turn: 13, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: streamedText }] } })
    emitLive('step/end', { turn: 13, step: 1 })
    emitLive('turn/end', { turn: 13, reason: { kind: 'completed' } })
  }

  mount.channel.clear()
  check('/clear drops navigation metadata and old aliases', indexedTurns().length === 0 && originalHandles.every(id => mount.channel.revealRow(id) === 0))
  check('/clear cannot revive old chunks through loadOlder', mount.channel.loadOlder() === 0 && !mount.channel.olderHistory)
  check('/clear removes all old rail ticks', await settled(() => railTicks().length === 0))

  await mount.channel.newSession()
  check('new DSH session contains no old metadata or aliases', creates === 1 && allTurnCount() === 0 && originalHandles.every(id => mount.channel.revealRow(id) === 0))
  check('fresh session does not resurrect the old rail', await settled(() => railTicks().length === 0))

  const resumed = await mount.channel.resumeTo('swap-rail-session')
  check('real resume adopts a replacement conversation with the same seed shape', resumed.ok && summaries().length === initialSummaries.length && allTurnCount() === 12)
  check('same-length replacement session refreshes the full rail', await settled(() => railTicks().length === 12 && visibleHumanRows().some(row => row.text === 'SWAP-PROMPT-12')))
  // Session adoption clears hover while its viewport settles. Move out, then
  // wait for stable hit-test geometry before entering the replacement tick.
  stdin.write('\x1b[<35;20;20M')
  let previousGeometry = ''
  let stablePasses = 0
  check('replacement geometry settles before mouse hit-testing', await settled(() => {
    const node = scrollNode()
    const geometry = JSON.stringify([node?.scrollTop, node?.scrollHeight, node?.scrollViewportHeight, railTicks()])
    stablePasses = geometry === previousGeometry ? stablePasses + 1 : 0
    previousGeometry = geometry
    return stablePasses >= 2 && railTicks().length === 12
  }))
  const swappedTickRow = railTicks()[targetOrdinal]
  assert.notEqual(swappedTickRow, undefined)
  stdin.write(`\x1b[<35;${COLS};${swappedTickRow! + 1}M`)
  check('same id/seq/preview-length replacement does not retain the old hover preview', await settled(() => screenLines().some(line => line.includes(`SWAP-PROMPT-${targetNumber}`))))
  check('replacement navigation metadata contains no prior-conversation prompt text', indexedTurns().every(turn => !turn.text.startsWith('RAIL-PROMPT-')))
  console.log(`\nCHUNKED RAIL ${failed === 0 ? 'OK' : 'FAILED'} (${passed} passed, ${failed} failed; image preview: ${t('transcript-image-message', { count: 1 })})`)
} finally {
  if (app !== undefined) await app.unmount()
  mount.dispose()
  unregister()
  raw.releaseContributions()
  for (const cleanup of effectCleanups.reverse()) cleanup()
  term.dispose()
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const cleanupPath = resolve(scratch)
  assert.ok(cleanupPath.startsWith(resolve(scratchPrefix)), 'refuse cleanup outside this test temp directory')
  rmSync(cleanupPath, { recursive: true, force: true })
}
if (failed > 0) process.exitCode = 1
