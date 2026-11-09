/** Real Chat/Ink/xterm regression using only an isolated synthetic channel.
 * Each independent scenario mounts a fresh Chat and xterm. The click checks
 * observe incremental frames without forcing a full repaint.
 * Run: node --import tsx/esm scripts/verify-settled-thinking-chat.mjs
 */
process.env.NODE_ENV = 'production'
const { rig, setLang, sleep, cleanup } = await import('./lib/thinking-test-rig.mjs')

let failed = 0, skipped = 0
function check(name, ok, lines = []) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) { failed++; console.error(lines.join('\n')) }
}
function skip(name, why) { skipped++; console.log(`SKIP: ${name}: ${why}`) }
const reason = (text, extra = {}) => ({ id: 1, kind: 'reasoning', text, streaming: false, ...extra })
const sentinel = { id: 999, kind: 'assistant', text: 'AFTER_REASONING_SENTINEL', streaming: false }
const has = (lines, text) => lines.some(line => line.includes(text))
const isThinkingHeader = line => /(?:⚓|\*)\s+Thinking\b/u.test(line)
const headerIndex = lines => lines.findIndex(isThinkingHeader)
const hint = line => /click\s+to\s+expand/i.test(line)
const shown = (line, prefix) => line.includes(prefix) && line.includes('…') && hint(line)
const rows = text => [reason(text), sentinel]

// Exactly one test fixture per semantic scenario; no replacement rows can
// leave old pixels from an unrelated case in its xterm. A failed readiness
// check gates every negative assertion so an old/blank screen cannot pass.
async function scenario(name, options, run) {
  let app
  try {
    app = await rig(options)
    await run(app)
  } catch (error) {
    check(`${name}: harness/overflow error: ${error instanceof Error ? error.message : String(error)}`, false, app?.screen() ?? [])
  } finally {
    if (app) {
      try { await app.close() }
      catch (error) { check(`${name}: close/output overflow: ${error instanceof Error ? error.message : String(error)}`, false) }
    }
  }
}
async function readyEnglish(app) {
  return app.wait(() => headerIndex(app.screen()) >= 0 && has(app.screen(), 'AFTER_REASONING_SENTINEL'))
}
function oneRow(lines, h) {
  return h >= 0 && lines.findIndex(line => line.includes('AFTER_REASONING_SENTINEL')) === h + 2
}
// Locate ASCII sentinel by actual terminal cells, never JS substring columns.
function sentinelStyle(app) {
  const target = 'AFTER_REASONING_SENTINEL', buffer = app.term.buffer.active
  for (let y = 0; y < app.term.rows; y++) {
    const line = buffer.getLine(buffer.baseY + y)
    if (!line) continue
    for (let x = 0; x <= app.term.cols - target.length; x++) {
      let candidate = ''
      for (let j = 0; j < target.length; j++) candidate += line.getCell(x + j)?.getChars() ?? ''
      if (candidate === target) {
        const cell = line.getCell(x)
        return [cell?.getFgColor(), cell?.getBgColor(), cell?.isBold(), cell?.isDim()]
      }
    }
  }
  return undefined
}

try {
  setLang('en')
  await scenario('settled and click', { initialRows: rows('START_REASONING explains initial logic\nBODY_ONLY_MIDDLE\nBODY_ONLY_TAIL') }, async app => {
    const ready = await readyEnglish(app)
    let lines = app.screen(), h = headerIndex(lines)
    check('fresh settled fixture and following sentinel are visible (green control)', ready, lines)
    check('settled summary is one visual row with prefix, ellipsis and click-to-expand hint',
      ready && oneRow(lines, h) && shown(lines[h], 'START_REASONING'), lines)
    check('settled summary does not show middle or tail', ready && !has(lines, 'BODY_ONLY_MIDDLE') && !has(lines, 'BODY_ONLY_TAIL'), lines)

    // Observe the actual incremental output, not a forced clean repaint.
    const clicked = ready && await app.click('Thinking', isThinkingHeader)
    const committedOpen = clicked && await app.wait(() => has(app.screen(), 'BODY_ONLY_MIDDLE') && has(app.screen(), 'BODY_ONLY_TAIL'))
    lines = app.screen()
    const opened = committedOpen && has(lines, 'BODY_ONLY_MIDDLE') && has(lines, 'BODY_ONLY_TAIL')
    check('SGR click expands settled reasoning to its body (green control)', opened, lines)
    await sleep(600) // 固定窗:墙钟 terminal double-click recognition window
    const clickedAgain = opened && await app.click('Thinking', isThinkingHeader)
    const committedClose = clickedAgain && await app.wait(() => !has(app.screen(), 'BODY_ONLY_MIDDLE') && !has(app.screen(), 'BODY_ONLY_TAIL'))
    lines = app.screen(); h = headerIndex(lines)
    check('second SGR click collapses body (green control)', committedClose && h >= 0 &&
      !has(lines, 'BODY_ONLY_MIDDLE') && !has(lines, 'BODY_ONLY_TAIL'), lines)
    check('second SGR click restores the summary', committedClose && oneRow(lines, h) && shown(lines[h], 'START_REASONING'), lines)
  })

  await scenario('short', { initialRows: rows('SHORT_PREFIX') }, async app => {
    const ready = await readyEnglish(app), lines = app.screen(), h = headerIndex(lines)
    check('short nonempty reasoning includes prefix and ellipsis', ready && oneRow(lines, h) && shown(lines[h], 'SHORT_PREFIX'), lines)
  })

  await scenario('count only', { initialRows: [reason('', { reasoningTokens: 68 }), sentinel] }, async app => {
    const isCountHeader = line => /(?:⚓|\*)\s+Thought\b/u.test(line) && line.includes('68')
    const ready = await app.wait(() => app.screen().some(isCountHeader) && has(app.screen(), 'AFTER_REASONING_SENTINEL'))
    const lines = app.screen(), header = lines.find(isCountHeader) ?? ''
    check('count-only remains count-only without fabricated summary or click hint (green control)',
      ready && !header.includes('…') && !hint(header) && !has(lines, 'SHORT_PREFIX'), lines)
  })

  setLang('zh')
  await scenario('Chinese', { initialRows: rows('中文前缀内容\n绝不能泄露后段') }, async app => {
    const isChineseHeader = line => /(?:⚓|\*)\s+思考/u.test(line)
    const ready = await app.wait(() => app.screen().some(isChineseHeader) && has(app.screen(), 'AFTER_REASONING_SENTINEL'))
    const lines = app.screen(), h = lines.findIndex(isChineseHeader)
    const header = lines[h] ?? ''
    check('Chinese summary shows prefix, ellipsis and localised click-to-expand hint', ready && oneRow(lines, h) &&
      header.includes('中文前缀') && header.includes('…') && /点击.{0,8}展开/.test(header) && !has(lines, '绝不能泄露后段'), lines)
  })
  setLang('en')

  let baselineStyle, baselineTitles
  await scenario('safety baseline', { initialRows: rows('BASELINE_NONEMPTY') }, async app => {
    const ready = await readyEnglish(app)
    baselineStyle = ready ? sentinelStyle(app) : undefined
    baselineTitles = ready ? [...app.titleChanges] : undefined
    check('fresh safety baseline renders sentinel and its cell style (green control)', ready && baselineStyle !== undefined, app.screen())
  })

  const hostile = 'SAFE_START ' + '\x1b]0;THINK_EVIL_TITLE\x07' + '\x1b]52;c;THINK_EVIL_CLIP\x07' +
    '\x1b]8;;https://invalid.example/THINK_EVIL_LINK\x07label\x1b]8;;\x07' + '\x1b[31m' + '\x1b[2J' + '\x1bPTHINK_EVIL_DCS\x1b\\' + '\nBODY_ONLY_TAIL'
  await scenario('control injection', { initialRows: rows(hostile) }, async app => {
    const ready = await readyEnglish(app), lines = app.screen(), output = app.getOutput()
    const exercised = ready && has(lines, 'SAFE_START')
    check('control-sequence probe actually paints the safe preview prefix', exercised, lines)
    if (!exercised) return skip('control sequence safety', 'preview absent: no sanitizer path was exercised')
    check('no hostile OSC/DCS reaches terminal or changes title and adjacent style',
      !output.includes('\x1b]0;THINK_EVIL_TITLE') && !output.includes('\x1b]52;c;THINK_EVIL_CLIP') &&
      !output.includes('https://invalid.example/THINK_EVIL_LINK') && !output.includes('\x1bPTHINK_EVIL_DCS') &&
      !app.titleChanges.includes('THINK_EVIL_TITLE') && baselineStyle !== undefined &&
      JSON.stringify(sentinelStyle(app)) === JSON.stringify(baselineStyle), lines)
  })

  const unterminatedOsc = '\x1b]52;c;THINK_UNCLOSED_OSC' + 'x'.repeat(2000)
  await scenario('unterminated control', { initialRows: rows('OPEN_PREFIX_X ' + unterminatedOsc) }, async app => {
    const ready = await readyEnglish(app), lines = app.screen()
    const exercised = ready && has(lines, 'OPEN_PREFIX')
    check('unterminated-sequence probe paints the safe prefix', exercised, lines)
    check('unterminated OSC cannot escape into terminal output or change the title', exercised &&
      !app.getOutput().includes('\x1b]52;c;THINK_UNCLOSED_OSC') &&
      !app.getOutput().includes(unterminatedOsc) && baselineTitles !== undefined &&
      JSON.stringify(app.titleChanges) === JSON.stringify(baselineTitles), lines)
  })

  // An output-size assertion is necessary but does NOT prove a bound on CPU,
  // input traversal, or memory allocation; run a separate measured probe.
  await scenario('large prefix', { initialRows: rows('LONG_START_' + 'x'.repeat(1_000_000) + 'LONG_END_MUST_NOT_PAINT') }, async app => {
    const ready = await readyEnglish(app), lines = app.screen(), h = headerIndex(lines)
    check('large reasoning emits bounded visible prefix, not its tail', ready && oneRow(lines, h) &&
      shown(lines[h], 'LONG_START_') && !has(lines, 'LONG_END_MUST_NOT_PAINT') && app.getOutput().length < 100_000, lines)
  })

  await scenario('Unicode', { initialRows: rows('宽前缀e\u0301👩‍💻' + '文'.repeat(160) + '\nUNICODE_HIDDEN_TAIL') }, async app => {
    const ready = await readyEnglish(app), lines = app.screen(), h = headerIndex(lines)
    check('Unicode prefix stays one row without broken glyph or hidden tail', ready && oneRow(lines, h) &&
      shown(lines[h], '宽前缀') && !lines[h].includes('�') && !has(lines, 'UNICODE_HIDDEN_TAIL'), lines)
  })

  await scenario('narrow', { columns: 32, rows: 30, initialRows: rows('宽屏测试😀' + '文'.repeat(150) + '\nNARROW_HIDDEN') }, async app => {
    const ready = await readyEnglish(app), lines = app.screen(), h = headerIndex(lines)
    // At narrow width not all summary text can fit; do not invent that promise.
    check('narrow settled row stays one line without broken glyph or tail leak', ready && oneRow(lines, h) &&
      !lines[h].includes('�') && !has(lines, 'NARROW_HIDDEN'), lines)
  })
} finally {
  setLang('en')
  cleanup()
}
console.log(`\nSETTLED THINKING: ${failed ? `${failed} FAILURE(S)` : skipped ? 'INCOMPLETE' : 'OK'}; ${skipped} skipped`)
process.exitCode = failed || skipped ? 1 : 0
