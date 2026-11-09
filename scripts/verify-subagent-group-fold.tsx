/**
 * Subagent fan-out group fold（历史默认只展开高价值行）。
 *
 * 一次 fan-out 会连着落下 N 张 `⑂` 子代理卡；逐张读它们几乎不提供组内
 * 聚合之外的任何信息，却把对话正文推到几屏之外。断言：
 *   1) 3 张已落定的卡默认折叠成组头一行（正文描述不可见）；
 *   2) 点击组头展开整组（描述可见、组头变 ▾ 标题），再点收回；
 *   3) Ctrl+O 展开全部、再按收回；
 *   4) 组内有 running 成员时不折叠（在跑的工作不许被收起来）。
 *
 * 运行：node --import tsx/esm scripts/verify-subagent-group-fold.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'kitty'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { settled, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 36
let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) }
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
const stdout = new FakeStdout() as any
const stderr = new FakeStderr() as any
const stdin = new FakeStdin() as any

function subagentCard(id: number, agentId: string, status: 'running' | 'completed'): any {
  const startedAt = Date.now() - 120_000
  return {
    id,
    kind: 'subagent',
    text: `子任务 ${agentId}：检索并归纳结论`,
    subagent: {
      agentId,
      runId: agentId,
      description: `工作者${id}：检索并归纳结论`,
      provider: 'dsh', model: 'deepseek-v4-flash', effort: 'medium',
      status,
      startedAt,
      completedAt: status === 'completed' ? startedAt + 60_000 : undefined,
      durationMs: status === 'completed' ? 60_000 : undefined,
      outputLines: status === 'running' ? ['正在读取 src/index.ts', '正在匹配 pattern', '第三行占位输出'] : [],
      toolCalls: [{ id: `${agentId}-c1`, name: 'Grep', status: 'ok', startedAt }],
      tokens: { total: 2048 },
      stopReason: status === 'completed' ? 'completed' : undefined,
    },
  }
}

const listeners = new Set<() => void>()
const channelRows: any[] = [
  { id: 0, kind: 'user', text: '开始并行子任务分析' },
  subagentCard(1, 'sa-1', 'completed'),
  subagentCard(2, 'sa-2', 'completed'),
  subagentCard(3, 'sa-3', 'completed'),
  { id: 90, kind: 'assistant', text: '汇总完成。' },
]
const channel: any = {
  version: 0, rows: channelRows, status: 'idle', sessionTitle: 'subagent-group', agentId: 'x',
  model: 'deepseek-v4-flash', reasoningEffort: 'max',
  tokens: { input: 100, output: 40 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo',
  gitBranch: 'main', working: false, spinnerMode: 'requesting', responseChars: 0,
  whaleIdle: false,
  activeToolCount: 0, turnStart: 0, lastUserText: '开始并行子任务分析',
  pending: [], commandList: [], notifications: [],
  mode: { plan: false }, effortLevels: undefined,
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => [],
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [],
}
const bump = (): void => { channel.version++; for (const cb of listeners) (cb as () => void)() }

await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false },
)
// 固定窗:pacing 等开机动画与首帧上屏，无单一可轮询锚点。
await sleep(1800)

const lines = (): string[] => {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}
const foldedRow = (ls: string[]): number => ls.findIndex(line => line.includes('已折叠 3 个子代理'))
const openRow = (ls: string[]): number => ls.findIndex(line => line.includes('子代理 ×3'))
const visibleDescriptions = (ls: string[]): number => ls.filter(line => line.includes('工作者')).length
/** 点击后的重绘在高负载下可能晚于任何固定等待：按结果轮询，超时才判失败。 */
const waitFor = (pred: () => boolean, ms = 3000): Promise<boolean> => settled(pred, { timeoutMs: ms })

// ---- 1. 默认折叠 ----
await waitFor(() => foldedRow(lines()) >= 0)
let ls = lines()
check('已落定的 3 张子代理卡默认折叠成组头一行', foldedRow(ls) >= 0, foldedRow(ls) >= 0 ? `行${foldedRow(ls)}` : '未找到')
check('折叠时不再逐张展示子代理卡', visibleDescriptions(ls) === 0, `cards=${visibleDescriptions(ls)}`)

// ---- 2. 点击组头展开，再点收回 ----
stdin.write(`\x1b[<0;3;${foldedRow(ls) + 1}M`)
stdin.write(`\x1b[<0;3;${foldedRow(ls) + 1}m`)
await waitFor(() => visibleDescriptions(lines()) === 3)
ls = lines()
check('点击组头展开整组', visibleDescriptions(ls) === 3, `cards=${visibleDescriptions(ls)}`)
check('展开后组头改为标题行', openRow(ls) >= 0, openRow(ls) >= 0 ? `行${openRow(ls)}` : '未找到')

// 双连击会被判双击选词，先等过 500ms 多击窗。
await sleep(600) // 固定窗:墙钟 多击判定窗本身是被测语义（500ms 内第二次点按算双击选词）。
const openIdx = openRow(lines())
stdin.write(`\x1b[<0;3;${openIdx + 1}M`)
stdin.write(`\x1b[<0;3;${openIdx + 1}m`)
await waitFor(() => foldedRow(lines()) >= 0)
ls = lines()
check('再点收回折叠行', foldedRow(ls) >= 0 && visibleDescriptions(ls) === 0,
  `folded=${foldedRow(ls)} cards=${visibleDescriptions(ls)}`)

// ---- 3. Ctrl+O 展开 / 收回 ----
stdin.write('\x0f')
await waitFor(() => visibleDescriptions(lines()) === 3)
check('Ctrl+O 展开全部子代理组', visibleDescriptions(lines()) === 3, `cards=${visibleDescriptions(lines())}`)
stdin.write('\x0f')
await waitFor(() => foldedRow(lines()) >= 0)
check('再按 Ctrl+O 收回', foldedRow(lines()) >= 0 && visibleDescriptions(lines()) === 0,
  `folded=${foldedRow(lines())} cards=${visibleDescriptions(lines())}`)

// ---- 4. 有 running 成员时不折叠 ----
// 换一批新行对象再 bump：投影的落定是**替换**行对象，原地改字段不换数组
// 身份会让窗口缓存继续吃旧切片。
channel.rows = channelRows.map((row: any) => {
  if (row.kind !== 'subagent') return row
  const { completedAt: _c, durationMs: _d, stopReason: _s, ...rest } = row.subagent
  return { ...row, subagent: { ...rest, status: 'running' } }
})
bump()
await waitFor(() => openRow(lines()) >= 0 && visibleDescriptions(lines()) === 3)
ls = lines()
check('组内有 running 成员时保持展开', visibleDescriptions(ls) === 3, `cards=${visibleDescriptions(ls)}`)
check('运行中的组头报告 live 数', ls.some(line => line.includes('运行中')), openRow(ls) >= 0 ? `行${openRow(ls)}` : '未找到')
check('运行中的组不会被折叠行替代', foldedRow(ls) === -1, `folded=${foldedRow(ls)}`)

console.log(failed === 0 ? '\nSUBAGENT GROUP FOLD OK' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
