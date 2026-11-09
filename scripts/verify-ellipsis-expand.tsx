/**
 * 静默省略号可展开回归（用户需求：被省略号折叠的文字点一下看全文，再点
 * 回到折叠态）。
 *
 * 主转录里带「点击展开」提示的折叠（长行/代码围栏/工具卡正文/思考摘要）
 * 已有点击链路；这里守的是**没有提示、只有 hover 才能看全**的那一类：
 *  1. 工具卡头部在窄终端被 `truncate-end` 截断的标题；
 *  2. 无标题卡的头部参数被 `clipHeaderArgs`（480 字符）截断。
 * 两者都在头部行里，省略号是唯一的提示。展开态（verbose）必须把被省掉的
 * 内容完整换行画出，再点一次回到折叠态——复用同一个 verbose 状态机，不
 * 引入第二套展开状态。
 *
 * 断言（两张卡各自独立渲染，避免整屏溢出干扰定位）：
 *  A. 折叠态：头部有省略号，尾串不在屏上，正文尾行也不在；
 *  B. 点卡面展开：尾串与正文尾行都出现；再点一次都消失；
 *  C. 冷渲染（verbose=true）与点击展开的整屏完全一致。
 *
 * Run: `node --import tsx/esm scripts/verify-ellipsis-expand.tsx`
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'verify-ellipsis-expand-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir
process.env.DSH_TUI_LANG = 'en'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, Box, AlternateScreen, useInput },
  { AssistantToolUseMessage },
  { SubagentDetailScene },
  termTest,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/messages/AssistantToolUseMessage.js'),
  import('../src/components/SubagentDetailScene.js'),
  import('./lib/term-test.mjs'),
])

const { sleep, settled, findText } = termTest as unknown as {
  sleep: (ms: number) => Promise<void>
  settled(pred: () => boolean, opts?: { timeoutMs?: number }): Promise<boolean>
  findText(term: InstanceType<typeof XTerm>, needle: string): { col: number; row: number } | null
}

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}

const COLS = 72
const ROWS = 30
const TITLE_HEAD = 'TITLEHEAD'
const TITLE_TAIL = 'TITLETAIL'
const ARGS_HEAD = 'ARGSHEAD'
const ARGS_TAIL = 'ARGSTAIL'
const BODY_TAIL = 'BODYTAIL'

const packed = (screen: string): string => screen.replace(/\s+/g, '')
const digest = (screen: string): string => {
  const rows = screen.split('\n').filter(row => row.trim() !== '')
  return `${rows.length} rows, first=${JSON.stringify((rows[0] ?? '').slice(0, 40))}`
}

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private term: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
    this.term.write(String(chunk), cb)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

/** 鼠标 SGR 左键 press+release（1 起坐标）；press/release 分帧，否则一次
 *  点击可能被两个处理器各算一遍。 */
async function click(stdin: PassThrough, col: number, row: number): Promise<void> {
  stdin.write(`\x1b[<0;${col};${row}M`)
  await sleep(30) // 固定窗:pacing press→release
  stdin.write(`\x1b[<0;${col};${row}m`)
}

/** Chat 常驻 PromptInput 才接鼠标解析；rig 里挂一个空 useInput。 */
function KeySink(): React.ReactNode {
  useInput(() => {})
  return null
}

const bodyLines = Array.from({ length: 8 }, (_, i) => `body line ${i}`)
const LONG_PATH = `/tmp/${'d'.repeat(120)}-${TITLE_HEAD}-${TITLE_TAIL}`
const bodyText = [...bodyLines.slice(0, -1), BODY_TAIL].join('\n')

/** 有标题的工具卡：标题超出 72 列，被 truncate-end 截断。 */
function titledFixture(): Record<string, unknown> {
  return {
    callId: 'read-call',
    name: 'read',
    argsText: '{}',
    status: 'done',
    callView: { card: 'read', title: `Read ${LONG_PATH}`, path: LONG_PATH },
    resultView: {
      card: 'read',
      title: `Read ${LONG_PATH}`,
      path: LONG_PATH,
      content: [{ type: 'text', text: bodyText }],
    },
    startedAt: Date.now() - 1_000,
    durationMs: 1_000,
  }
}

/** 无标题的工具卡：参数就是头部，480 字符预算处被 clipHeaderArgs 截断。 */
function untitledFixture(): Record<string, unknown> {
  return {
    callId: 'custom-call',
    name: 'mytool',
    argsText: JSON.stringify({ query: `${ARGS_HEAD}${'a'.repeat(540)}${ARGS_TAIL}` }),
    argsFull: JSON.stringify({ query: `${ARGS_HEAD}${'a'.repeat(540)}${ARGS_TAIL}${'b'.repeat(200)}` }),
    status: 'done',
    callView: { card: 'generic' },
    resultView: { card: 'generic', content: [{ type: 'text', text: bodyText }] },
    startedAt: Date.now() - 1_000,
    durationMs: 1_000,
  }
}

interface Frame {
  term: InstanceType<typeof XTerm>
  stdin: FakeStdin
  screen(): string
  clickText(needle: string): Promise<boolean>
  opened(): number
  unmount(): Promise<void>
}

/** 有状态卡：onClick 走 React state 再渲染 verbose（与 Chat 的
 *  expandedRows → verbose 同构）。 */
function Card({ tool, initial, onOpenFile }: {
  tool: Record<string, unknown>
  initial: boolean
  onOpenFile: () => void
}): React.ReactNode {
  const [verbose, setVerbose] = React.useState(initial)
  return (
    <AssistantToolUseMessage
      tool={tool as never}
      marginTopOnTurn={false}
      verbose={verbose}
      onClick={() => setVerbose(previous => !previous)}
      onOpenFile={onOpenFile}
    />
  )
}

async function mount(tool: Record<string, unknown>, verbose: boolean): Promise<Frame> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term)
  const stderr = new FakeStderr()
  const stdin = new FakeStdin()
  let opened = 0
  const onOpenFile = (): void => { opened += 1 }
  const instance = await render(
    <AlternateScreen>
      <KeySink />
      <Box flexDirection="column" width={COLS}>
        <Card tool={tool} initial={verbose} onOpenFile={onOpenFile} />
      </Box>
    </AlternateScreen>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(200) // 固定窗:pacing 首次布局无单一可观测锚点
  const screen = (): string =>
    Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  return {
    term,
    stdin,
    screen,
    opened: () => opened,
    async clickText(needle: string): Promise<boolean> {
      const hit = findText(term, needle)
      if (hit === null) return false
      await click(stdin, hit.col + 1, hit.row + 1)
      return true
    },
    async unmount(): Promise<void> {
      await instance.unmount()
      term.dispose()
    },
  }
}

interface Case {
  label: string
  tool: Record<string, unknown>
  /** 折叠态下在屏上的头部片段（点击目标）。 */
  headNeedle: string
  /** 展开后出现、折叠时被省掉的尾串。 */
  tailNeedle: string
}

const CASES: Case[] = [
  { label: 'titled', tool: titledFixture(), headNeedle: '/tmp/dddd', tailNeedle: TITLE_TAIL },
  { label: 'untitled', tool: untitledFixture(), headNeedle: 'Mytool', tailNeedle: ARGS_TAIL },
]

// ---------------------------------------------------------------------------
// A — 折叠态：只有省略号，没有全文
// ---------------------------------------------------------------------------
console.log('--- A: silent ellipsis hides the tail ---')
for (const c of CASES) {
  const frame = await mount(c.tool, false)
  try {
    const text = frame.screen()
    check(`A ${c.label}: collapsed header shows the head`,
      packed(text).includes(packed(c.headNeedle)), digest(text))
    check(`A ${c.label}: collapsed header hides the tail`,
      !packed(text).includes(c.tailNeedle), digest(text))
    check(`A ${c.label}: collapsed header shows an ellipsis`, text.includes('…'), digest(text))
    check(`A ${c.label}: body tail is folded away`,
      !packed(text).includes(BODY_TAIL), digest(text))
  } finally {
    await frame.unmount()
  }
}

// ---------------------------------------------------------------------------
// B — 点一下看全文，再点回到折叠态
// ---------------------------------------------------------------------------
console.log('--- B: click expands, click again folds ---')
for (const c of CASES) {
  const frame = await mount(c.tool, false)
  try {
    check(`B ${c.label}: header is on screen to click`,
      await frame.clickText(c.headNeedle), digest(frame.screen()))
    check(`B ${c.label}: click paints the full tail`,
      await settled(() => packed(frame.screen()).includes(c.tailNeedle)), digest(frame.screen()))
    check(`B ${c.label}: click also opens the body tail`,
      packed(frame.screen()).includes(BODY_TAIL), digest(frame.screen()))
    check(`B ${c.label}: the expanded tail is on screen to click back`,
      await frame.clickText(c.tailNeedle), digest(frame.screen()))
    check(`B ${c.label}: second click hides the tail again`,
      await settled(() => !packed(frame.screen()).includes(c.tailNeedle)), digest(frame.screen()))
    check(`B ${c.label}: collapsing click did not open the file menu`,
      frame.opened() === 0, String(frame.opened()))
    check(`B ${c.label}: second click folds the body tail away`,
      !packed(frame.screen()).includes(BODY_TAIL), digest(frame.screen()))
    check(`B ${c.label}: the ellipsis is back`, frame.screen().includes('…'), digest(frame.screen()))
  } finally {
    await frame.unmount()
  }
}

// ---------------------------------------------------------------------------
// C — 冷渲染（verbose=true）与点击展开同屏
// ---------------------------------------------------------------------------
console.log('--- C: cold verbose render equals the clicked one ---')
for (const c of CASES) {
  let clicked = ''
  {
    const frame = await mount(c.tool, false)
    try {
      await frame.clickText(c.headNeedle)
      await settled(() => packed(frame.screen()).includes(c.tailNeedle))
      clicked = packed(frame.screen())
    } finally {
      await frame.unmount()
    }
  }
  const cold = await mount(c.tool, true)
  try {
    const text = packed(cold.screen())
    check(`C ${c.label}: cold expanded paints the tail`, text.includes(c.tailNeedle), digest(cold.screen()))
    check(`C ${c.label}: cold and clicked expanded screens agree`, text === clicked,
      `${text.length} vs ${clicked.length} chars`)
  } finally {
    await cold.unmount()
  }
}


// ---------------------------------------------------------------------------
// D — 详情页转录里的思考摘要：落定后同样只是省略号，点一下必须能看全
// ---------------------------------------------------------------------------
console.log('--- D: detail transcript thinking leaf expands on click ---')
{
  const THINK_HEAD = 'THINKHEAD'
  const THINK_TAIL = 'THINKTAIL'
  const thinkingText = `${THINK_HEAD} ${'y'.repeat(200)} ${THINK_TAIL}`
  const events = [{
    type: 'assistant.message',
    anchor: 'a-think',
    time: Date.now(),
    blocks: [{ type: 'reasoning', text: thinkingText }, { type: 'text', text: 'after thinking' }],
  }]
  const detail = {
    agentId: 'agent-child-0001',
    description: 'research the spec',
    status: 'completed',
    startedAt: Date.now() - 60_000,
    completedAt: Date.now() - 10_000,
    mode: 'continuable',
    output: [],
    outputEvents: [],
    toolCalls: [],
  }
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term)
  const stdoutCast = stdout as unknown as NodeJS.WriteStream
  const stdin = new FakeStdin()
  const instance = await render(
    <AlternateScreen>
      <KeySink />
      <SubagentDetailScene
        subagent={detail as never}
        onBack={() => {}}
        loadTranscript={async () => ({
          events, parentAgentId: 'parent', uuids: [], hasOlder: false, skippedFromStart: 0,
        }) as never}
      />
    </AlternateScreen>,
    {
      stdout: stdoutCast,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const screen = (): string =>
    Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  const clickText = async (needle: string): Promise<boolean> => {
    const hit = findText(term, needle)
    if (hit === null) return false
    await click(stdin, hit.col + 1, hit.row + 1)
    return true
  }
  try {
    // 固定窗:pacing 详情场景首帧没有单一可轮询锚点，等一次布局落定
    await sleep(200)
    check('D detail: the transcript tab is on screen', await clickText('Transcript'), digest(screen()))
    check('D detail: the thinking summary is up', await settled(() => packed(screen()).includes(THINK_HEAD), { timeoutMs: 5000 }), digest(screen()))
    check('D detail: collapsed summary hides the tail', !packed(screen()).includes(THINK_TAIL), digest(screen()))
    check('D detail: collapsed summary advertises the click',
      /click|expand/i.test(screen()), digest(screen()))
    check('D detail: the summary is clickable', await clickText(THINK_HEAD), digest(screen()))
    check('D detail: click paints the full thinking text',
      await settled(() => packed(screen()).includes(THINK_TAIL), { timeoutMs: 5000 }), digest(screen()))
    check('D detail: click again folds it back', await clickText(THINK_TAIL), digest(screen()))
    check('D detail: the tail is folded away again',
      await settled(() => !packed(screen()).includes(THINK_TAIL), { timeoutMs: 5000 }), digest(screen()))
  } finally {
    await instance.unmount()
    term.dispose()
  }
}

console.log('')
if (failed > 0) {
  console.error(`verify-ellipsis-expand: ${failed} FAILURE(S)`)
  process.exit(1)
}
console.log('verify-ellipsis-expand: all checks passed')
