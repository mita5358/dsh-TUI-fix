/**
 * verify-timeline-geometry — timeline rail 纯几何模型的单元检查（对齐
 * grok-build xai-grok-pager views/timeline.rs 的测试矩阵）。
 *
 * 覆盖：
 *   - 资格门：turn 数 / 终端宽 / 视口行数 / 可滚动性；
 *   - 小对话：全量 tick 垂直居中；
 *   - 溢出窗口：围绕 active 滑动、active 收尾 clamp、无 active 锚定末尾、
 *     at-bottom 贴尾但绝不排除 active；
 *   - railHit 行 ↔ (▲/tick/▼) 映射；
 *   - timelineTargets：严格导航、折叠前缀、摘要代理与随机加载的中间块；
 *   - clipPreview：首个非空行、120 字符上限 + …；
 *   - wrapPreviewLines：CJK 宽度、两行上限、末行省略。
 *
 * 运行：node --import tsx/esm scripts/verify-timeline-geometry.ts
 */
import {
  RAIL_WIDTH,
  railEligible,
  computeRailGeometry,
  railHit,
  timelineTargets,
  clipPreview,
  wrapPreviewLines,
  type TimelineTurn,
} from '../src/ink/timeline-rail.js'
import { stringWidth } from '../src/ink/stringWidth.js'

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ── 资格门 ──
check('turn<2 隐藏', computeRailGeometry(1, 20, 0, false) === null)
check('viewport=2 隐藏（放不下 ▲+tick+▼）', computeRailGeometry(5, 2, 0, false) === null)
check('viewport=3 恰好 1 tick', computeRailGeometry(5, 3, 2, false) !== null &&
  computeRailGeometry(5, 3, 2, false)!.windowEnd - computeRailGeometry(5, 3, 2, false)!.windowStart === 1)
check('eligibility: 窄终端', !railEligible({ turnCount: 8, terminalWidth: 59, viewportRows: 30, scrollable: true }))
check('eligibility: 60 列', railEligible({ turnCount: 8, terminalWidth: 60, viewportRows: 30, scrollable: true }))
check('eligibility: 内容不足一屏（inline）', !railEligible({ turnCount: 8, terminalWidth: 100, viewportRows: 30, scrollable: false }))
check('eligibility: turn<2', !railEligible({ turnCount: 1, terminalWidth: 100, viewportRows: 30, scrollable: true }))
check('rail 宽 2 列', RAIL_WIDTH === 2)

// ── 小对话：全量 + 居中（grok: small_conversation_shows_all_ticks_centered）──
{
  const geo = computeRailGeometry(4, 20, 1, false)!
  check('4 turn 全显示', eq([geo.windowStart, geo.windowEnd], [0, 4]))
  check('6 行块在 20 行居中: upRow=7', geo.upRow === 7, `upRow=${geo.upRow}`)
  check('tickTop=8 downRow=12', geo.tickTop === 8 && geo.downRow === 12, `${geo.tickTop}/${geo.downRow}`)
}

// ── 溢出窗口（grok: overflow_windows_around_active）──
{
  const geo = computeRailGeometry(50, 20, 25, false)!
  check('50 turn/18 行: 窗口 18', geo.windowEnd - geo.windowStart === 18)
  check('窗口含 active', geo.windowStart <= 25 && 25 < geo.windowEnd)
  check('围绕 active: start=16', geo.windowStart === 25 - 9, `start=${geo.windowStart}`)
  check('active=49 收尾', (() => { const g = computeRailGeometry(50, 20, 49, false)!; return eq([g.windowStart, g.windowEnd], [32, 50]) })())
  check('active=null 锚定末尾', (() => { const g = computeRailGeometry(50, 20, null, false)!; return eq([g.windowStart, g.windowEnd], [32, 50]) })())
  check('at-bottom 贴尾但含 active', (() => { const g = computeRailGeometry(50, 20, 25, true)!; return eq([g.windowStart, g.windowEnd], [25, 43]) })())
  check('at-bottom active 已在尾部 → 固定末尾', (() => { const g = computeRailGeometry(50, 20, 40, true)!; return eq([g.windowStart, g.windowEnd], [32, 50]) })())
}

// ── 索引浏览覆盖：windowStart 参数压过自动窗口，并 clamp 到整窗 ──
{
  check('windowStart=3 覆盖自动窗口', (() => { const g = computeRailGeometry(50, 20, 25, false, 3)!; return eq([g.windowStart, g.windowEnd], [3, 21]) })())
  check('windowStart 负值 clamp 到 0', (() => { const g = computeRailGeometry(50, 20, 25, false, -5)!; return eq([g.windowStart, g.windowEnd], [0, 18]) })())
  check('windowStart 超尾 clamp 到 tail', (() => { const g = computeRailGeometry(50, 20, 25, false, 999)!; return eq([g.windowStart, g.windowEnd], [32, 50]) })())
  check('windowStart 覆盖 at-bottom 也生效', (() => { const g = computeRailGeometry(50, 20, 25, true, 10)!; return eq([g.windowStart, g.windowEnd], [10, 28]) })())
  check('turn 数不足时 windowStart 恒为 0', (() => { const g = computeRailGeometry(4, 20, 1, false, 7)!; return eq([g.windowStart, g.windowEnd], [0, 4]) })())
}

// ── railHit 映射（grok: hit_maps_chevrons_and_ticks）──
{
  const geo = computeRailGeometry(4, 20, 1, false)!
  check('▲ 行命中', eq(railHit(geo, geo.upRow), { kind: 'up' }))
  check('▼ 行命中', eq(railHit(geo, geo.downRow), { kind: 'down' }))
  check('首 tick = turn 0', eq(railHit(geo, geo.tickTop), { kind: 'tick', index: 0 }))
  check('末 tick = turn 3', eq(railHit(geo, geo.tickTop + 3), { kind: 'tick', index: 3 }))
  check('块外行未命中', railHit(geo, geo.upRow - 1) === null && railHit(geo, geo.downRow + 1) === null)
  const of = computeRailGeometry(50, 20, 25, false)!
  check('溢出窗口行映射窗口内序号', eq(railHit(of, of.tickTop), { kind: 'tick', index: of.windowStart }))
}

// ── timelineTargets：普通真实轮次保持严格的视口顶部锚定 ──
{
  const turns: TimelineTurn[] = [10, 30, 50, 80].map((top, index) => ({ id: index + 1, top, preview: `turn ${index + 1}` }))
  const targets = (viewTop: number, maxScroll = 60) => timelineTargets(turns, viewTop, maxScroll)
  check('导航: pre-turn 内容以首轮作 active，不置顶', eq(targets(0), {
    activeId: 1, pinnedId: null, upId: null, downId: 1,
  }))
  check('导航: prompt 恰在顶行，▲严格排除当前轮', eq(targets(30), {
    activeId: 2, pinnedId: null, upId: 1, downId: 3,
  }))
  check('导航: 轮次中部先▲对齐本轮，▼到下一轮', eq(targets(40), {
    activeId: 2, pinnedId: 2, upId: 2, downId: 3,
  }))
  check('导航: ▼排除超过 maxScroll 的真实尾轮', eq(targets(60), {
    activeId: 3, pinnedId: 3, upId: 3, downId: null,
  }))
  check('导航: maxScroll 上的真实 prompt 仍可达', targets(40, 50).downId === 3)
  check('导航: maxScroll 之下不可达的 prompt 不成为▼', targets(40, 49).downId === null)
}

// ── 从索引加载中间块，两侧仍各有摘要代理 ──
{
  const turns: TimelineTurn[] = [
    { id: -11, top: 10, preview: 'older A', folded: true },
    { id: -12, top: 10, preview: 'older B', folded: true },
    { id: 21, top: 30, preview: 'loaded A' },
    { id: 22, top: 50, preview: 'loaded B' },
    { id: -31, top: 80, preview: 'newer A', folded: true },
    { id: -32, top: 80, preview: 'newer B', folded: true },
    { id: 41, top: 100, preview: 'tail' },
  ]
  const targets = (viewTop: number, maxScroll = 120) => timelineTargets(turns, viewTop, maxScroll)
  check('代理: 下方未加载块不覆盖中间真实 active/▲', eq(targets(40), {
    activeId: 21, pinnedId: 21, upId: 21, downId: 22,
  }))
  check('代理: 中间真实 prompt 顶部▼取下方摘要第一轮', eq(targets(50), {
    activeId: 22, pinnedId: null, upId: 21, downId: -31,
  }))
  check('代理: 摘要上方▼取该组第一轮，▲保持真实前轮', eq(targets(70), {
    activeId: 22, pinnedId: 22, upId: 22, downId: -31,
  }))
  check('代理: 同摘要多轮以末轮代表 active，但不伪造置顶 prompt', eq(targets(80), {
    activeId: -32, pinnedId: null, upId: 22, downId: 41,
  }))
  check('代理: 摘要严格上方▲取组末轮，仍不置顶', eq(targets(90), {
    activeId: -32, pinnedId: null, upId: -32, downId: 41,
  }))
  check('代理: 后方真实轮 active 不受前方摘要干扰', eq(targets(100), {
    activeId: 41, pinnedId: null, upId: -32, downId: null,
  }))
  check('代理: ▼可揭示当前 maxScroll 之外的摘要，加载后再计算真坐标', targets(50, 60).downId === -31)
  check('代理: 上方多轮▲取最后一个，不能跳到下方摘要', eq(targets(20), {
    activeId: -12, pinnedId: null, upId: -12, downId: 21,
  }))
}

// ── fold window 外的未知前缀与空列表 ──
{
  const turns: TimelineTurn[] = [
    { id: 1, top: -1, preview: 'folded A', folded: true },
    { id: 2, top: -1, preview: 'folded B', folded: true },
    { id: 3, top: 20, preview: 'visible A' },
    { id: 4, top: 50, preview: 'visible B' },
  ]
  check('未知前缀: 可作▲，不覆盖真实 active', eq(timelineTargets(turns, 30, 100), {
    activeId: 3, pinnedId: 3, upId: 3, downId: 4,
  }))
  check('未知前缀: 首个真实 prompt 顶部▲取最近折叠轮', eq(timelineTargets(turns, 20, 100), {
    activeId: 3, pinnedId: null, upId: 2, downId: 4,
  }))
  check('未知前缀: 无 measured active 时保留既有首轮 fallback', eq(timelineTargets(turns, 0, 100), {
    activeId: 1, pinnedId: 1, upId: 2, downId: 3,
  }))
  check('导航: 无轮次时所有目标均为空', eq(timelineTargets([], 0, 100), {
    activeId: null, pinnedId: null, upId: null, downId: null,
  }))
  check('未知前缀: 全折叠仍能向上揭示，但没有▼', eq(timelineTargets(turns.slice(0, 2), 0, 100), {
    activeId: 1, pinnedId: 1, upId: 2, downId: null,
  }))
}

// ── clipPreview ──
check('跳过前导空行', clipPreview('\n\n  你好 世界  \n第二行') === '你好 世界')
{
  const long = 'x'.repeat(500)
  const p = clipPreview(long)
  check('120 上限 + …', p.length === 120 && p.endsWith('…'), `len=${p.length}`)
}

// ── wrapPreviewLines（CJK 感知）──
{
  const lines = wrapPreviewLines('问题 二', 4)
  check('CJK 按显示宽换行（4 列 → 2 行）', lines.length === 2 && stringWidth(lines[0]!) <= 4, JSON.stringify(lines))
  const ell = wrapPreviewLines('一二三四五六七八九十', 4)
  check('第二行截断加 …', ell.length === 2 && ell[1]!.endsWith('…') && stringWidth(ell[1]!) <= 4, JSON.stringify(ell))
  const one = wrapPreviewLines('短句', 16)
  check('短句单行', one.length === 1 && one[0] === '短句')
  const ascii = wrapPreviewLines('abcdefgh', 4)
  check('ASCII 硬切', eq(ascii, ['abcd', 'efgh']), JSON.stringify(ascii))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
