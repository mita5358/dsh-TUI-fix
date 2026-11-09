/**
 * verify-rail-index-scroll — 时间线 rail 的「索引栏独立滚动」回归。
 *
 * 行为契约（2026-11-09 主人定稿）：▲/▼ 三角与「指针在 rail 区域时的鼠标
 * 滚轮」只翻动 tick 索引窗口，不跳轮次、不滚动转录；到顶/到底三角变暗且
 * no-op。索引窗口被翻走后 ━━（active）可不在窗口内；点 tick / 转录真正
 * 滚动才回到自动窗口。
 *
 * 做法：直接挂载 TimelineRail（假 handle，viewport=12、content=400、20 轮
 * ⇒ 一屏 10 tick），用无头 xterm 的 SGR 鼠标事件点三角 / 悬停 tick / 在
 * rail 上滚轮，再以预览卡文案（零填充「问题 NN」）读出窗口首轮；同时断言
 * 假 handle 的 scrollTo/scrollBy 零调用——索引滚动绝不能碰转录。
 *
 * 运行：node --import tsx/esm scripts/verify-rail-index-scroll.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'
delete process.env.TMUX

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen, Box, Text, useInput }, { TimelineRail }, { settle, settled, sleep }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/TimelineRail.js'),
  import('./lib/term-test.mjs'),
])

const COLS = 100
const ROWS = 12
const VIEWPORT = 12
const CONTENT = 400
const TURNS = 20
/** 12 行视口 − 2 个三角 = 一屏 10 个 tick。 */
const SHOWN = VIEWPORT - 2

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    term.write(String(chunk), cb)
  }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()

/** 转录滚动的证据面：任何索引操作都不得让它增长。 */
const scrollCalls: string[] = []
const scrollListeners = new Set<() => void>()
const notifyTranscriptScroll = () => { for (const fn of scrollListeners) fn() }
let fakeScrollTop = 0
const fakeHandle = {
  scrollTo(y: number) { scrollCalls.push(`to:${y}`); fakeScrollTop = Math.max(0, Math.floor(y)) },
  scrollBy(dy: number) { scrollCalls.push(`by:${dy}`) },
  scrollToElement() {},
  scrollToBottom() { scrollCalls.push('bottom') },
  getScrollIntentVersion: () => 0,
  getScrollTop: () => fakeScrollTop,
  getPendingDelta: () => 0,
  getScrollHeight: () => CONTENT,
  getFreshScrollHeight: () => CONTENT,
  getViewportHeight: () => VIEWPORT,
  getViewportTop: () => 0,
  isSticky: () => false,
  subscribe(fn: () => void) {
    scrollListeners.add(fn)
    return () => { scrollListeners.delete(fn) }
  },
  setClampBounds() {},
}

// 零填充让预览卡文案互为唯一子串（问题 10 不会误中 问题 1）。
const turns = Array.from({ length: TURNS }, (_, i) => ({
  id: i + 1,
  top: i * 20,
  preview: `问题 ${String(i + 1).padStart(2, '0')}`,
  folded: false,
}))

function Scene() {
  useInput(() => {})
  return (
    <AlternateScreen>
      <Box flexDirection="row" width={COLS} height={ROWS}>
        <Box width={COLS - 2}>
          <Text>正文</Text>
        </Box>
        <TimelineRail
          handle={fakeHandle as any}
          turns={turns}
          activeId={turns[0]!.id}
          terminalWidth={COLS}
          hoverEnabled
          onRevealTurn={() => {}}
          onJumpTurn={() => {}}
        />
      </Box>
    </AlternateScreen>
  )
}

const inst = await render(<Scene />, {
  stdout: stdout as any, stdin: stdin as any, stderr: stderr as any,
  exitOnCtrlC: false, patchConsole: false,
})

function screenLines(): string[] {
  const buf = term.buffer.active
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
}
const hasText = (text: string): boolean => screenLines().some(l => l.includes(text))
const railCellRow = (chars: string): number => {
  const buf = term.buffer.active
  for (let y = 0; y < ROWS; y++) {
    if (buf.getLine(buf.baseY + y)?.getCell(COLS - 1)?.getChars() === chars) return y
  }
  return -1
}
const ACTIVE_TICK = '━━'

await settled(() => railCellRow('▴') >= 0 && railCellRow('▾') >= 0 && railCellRow('━') >= 0)
const geo = {
  up: railCellRow('▴'),
  down: railCellRow('▾'),
  firstTick: railCellRow('━'),
}
check('rail 就绪：▲ 在顶、▼ 在底、active 首 tick', geo.up === 0 && geo.down === ROWS - 1 && geo.firstTick === 1,
  `up=${geo.up} down=${geo.down} first=${geo.firstTick}`)

// SGR 鼠标：click = press+release；悬停一律先移开再进入，确保 enter 重放。
const clickAt = async (row: number) => {
  stdin.write(`\x1b[<35;${COLS};${row + 1}M`)
  // 固定窗:pacing 让 enter 先落定，避免同一格连续 press 被折叠
  await sleep(30)
  stdin.write(`\x1b[<0;${COLS};${row + 1}M`)
  stdin.write(`\x1b[<0;${COLS};${row + 1}m`)
  // 固定窗:pacing 点击 handler 的 React 提交没有可轮询的落定锚点
  await sleep(120)
}
const hoverFirstTick = async () => {
  stdin.write(`\x1b[<35;50;${Math.floor(ROWS / 2)}M`)
  // 固定窗:pacing 先把指针移出 rail，清掉上一张卡
  await sleep(30)
  stdin.write(`\x1b[<35;${COLS};${geo.firstTick + 1}M`)
  // 固定窗:pacing 预览卡 dwell 门 120ms，再给挂载留一帧
  await sleep(220)
}
const wheelAt = async (up: boolean) => {
  stdin.write(`\x1b[<${up ? 64 : 65};${COLS};${Math.floor(ROWS / 2)}M`)
  // 固定窗:pacing 滚轮走 host 分派→React handler，无逐步可轮询条件
  await sleep(160)
}

// ── 1. 初始窗口 [1..10]：悬停首 tick = 问题 01 ──
await hoverFirstTick()
{
  check('初始窗口首 tick = 问题 01', hasText('问题 01'))
  check('初始窗口内 active 仍可见（━━）', hasText(ACTIVE_TICK))
}

// ── 2. ▼ 一次：窗口下移 1（首 tick = 问题 02），不跳轮次、不滚转录 ──
await clickAt(geo.down)
await hoverFirstTick()
{
  check('▼ 后窗口首 tick = 问题 02', hasText('问题 02') && !hasText('问题 01'))
  check('窗口离开 active 后 ━━ 不显示', !hasText(ACTIVE_TICK))
  check('▼ 未滚动转录', scrollCalls.length === 0, `calls=${JSON.stringify(scrollCalls)}`)
}

// ── 3. 连点 ▼ 到索引末尾：首 tick = 问题 11；再点变暗 no-op ──
for (let i = 0; i < TURNS - SHOWN - 1; i++) await clickAt(geo.down)
await hoverFirstTick()
{
  check('▼ 到索引末尾：首 tick = 问题 11', hasText('问题 11'))
  await clickAt(geo.down)
  await hoverFirstTick()
  check('末尾 ▼ 变暗 no-op（仍 问题 11）', hasText('问题 11'))
  check('末尾 no-op 未滚动转录', scrollCalls.length === 0, `calls=${JSON.stringify(scrollCalls)}`)
}

// ── 4. 连点 ▲ 回索引开头：首 tick = 问题 01；再点变暗 no-op ──
for (let i = 0; i < TURNS - SHOWN; i++) await clickAt(geo.up)
await hoverFirstTick()
{
  check('▲ 回索引开头：首 tick = 问题 01', hasText('问题 01'))
  await clickAt(geo.up)
  await hoverFirstTick()
  check('开头 ▲ 变暗 no-op（仍 问题 01）', hasText('问题 01'))
  check('▲ no-op 未滚动转录', scrollCalls.length === 0, `calls=${JSON.stringify(scrollCalls)}`)
}

// ── 5. rail 上滚轮：只翻索引（格距 3），不滚转录 ──
await wheelAt(false)
await hoverFirstTick()
{
  check('滚轮下翻 1 格：窗口首 tick = 问题 04', hasText('问题 04') && !hasText('问题 01'))
  check('滚轮翻索引未滚动转录', scrollCalls.length === 0, `calls=${JSON.stringify(scrollCalls)}`)
}

// ── 6. 真实转录滚动：索引窗口交还自动跟随 ──
notifyTranscriptScroll()
await hoverFirstTick()
{
  check('转录滚动后索引窗口回到自动跟随（问题 01）', hasText('问题 01') && !hasText('问题 04'))
}

// ── 7. 点 tick 也回自动跟随：再翻走后点首 tick ──
await wheelAt(false)
await hoverFirstTick()
check('再翻走：首 tick = 问题 04', hasText('问题 04'))
// handle 不发通知（模拟 seek 恰好无滚动）：tick 点击自身必须把窗口交还自动跟随。
await clickAt(geo.firstTick)
await hoverFirstTick()
{
  check('点 tick 后索引窗口回自动跟随（问题 01）', hasText('问题 01') && !hasText('问题 04'))
  check('全程索引操作未滚动转录', scrollCalls.length === 0, `calls=${JSON.stringify(scrollCalls)}`)
}

// ── 8. 已在索引顶部：滚轮上翻 no-op ──
await wheelAt(true)
await hoverFirstTick()
{
  check('顶部滚轮上翻 no-op（仍 问题 01）', hasText('问题 01'))
  check('全程零转录滚动', scrollCalls.length === 0, `calls=${JSON.stringify(scrollCalls)}`)
}

await inst.unmount()
if (failed > 0) {
  console.error(`verify-rail-index-scroll: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('verify-rail-index-scroll: all checks passed')
