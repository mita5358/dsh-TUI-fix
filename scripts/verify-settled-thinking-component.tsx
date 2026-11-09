// Lightweight single-component renderer check; no Chat, sessions, or PTY.
// React chooses its build when imported, so set production before imports.
process.env.NODE_ENV = 'production'
process.env.DSH_TUI_LANG = 'en'
const [assertModule, React, { Box }, { TerminalSizeContext }, { renderToScreen }, { cellAtIndex }, { AssistantThinkingMessage }, keymap] = await Promise.all([
  import('node:assert/strict'), import('react'), import('../src/ui.js'),
  import('../src/ink/components/TerminalSizeContext.js'), import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'), import('../src/components/messages/AssistantThinkingMessage.js'),
  import('../src/utils/keymap.js'),
])
const assert = assertModule.default
function snap(element: React.ReactElement, width: number): string[] {
  const wrapped = <TerminalSizeContext.Provider value={{ columns: width, rows: 40 }}><Box flexDirection="column" width={width}>{element}</Box></TerminalSizeContext.Provider>
  const rendered = renderToScreen(wrapped, width)
  return Array.from({ length: rendered.height }, (_, y) => {
    let line = ''
    for (let x = 0; x < width; x++) line += cellAtIndex(rendered.screen, y * width + x).char
    return line.trimEnd()
  })
}
const sample = 'START思考😀\nBODY_ONLY_MIDDLE\nBODY_ONLY_TAIL'
const folded = snap(<AssistantThinkingMessage thinking={sample} marginTopOnTurn={false} verbose={false} isSelected onClick={() => {}} />, 100)
assert.equal(folded.length, 1, JSON.stringify(folded))
assert.ok(folded[0]?.includes('START思考😀'), JSON.stringify(folded))
assert.ok(folded[0]?.includes('…'))
assert.ok(!folded.join('\n').includes('BODY_ONLY_'))
assert.ok(folded[0]?.toLowerCase().includes('ctrl+o'), JSON.stringify(folded))
assert.ok(folded[0]?.includes('click to expand'), JSON.stringify(folded))
const noClick = snap(<AssistantThinkingMessage thinking="short" marginTopOnTurn={false} verbose={false} />, 100)
assert.ok(!noClick[0]?.includes('click to expand'))
assert.ok(noClick[0]?.includes('short…'))
const emptyFirst = snap(<AssistantThinkingMessage thinking={'\nSTART\nBODY_ONLY_TAIL'} marginTopOnTurn={false} verbose={false} />, 100)
assert.ok(emptyFirst[0]?.includes('START…') && !emptyFirst[0]?.includes('BODY_ONLY_TAIL'), JSON.stringify(emptyFirst))
const counts = snap(<AssistantThinkingMessage thinking="" reasoningTokens={500} marginTopOnTurn={false} verbose={false} />, 100)
assert.equal(counts.length, 1)
assert.ok(counts[0]?.includes('tokens') && !counts[0]?.includes('click to expand') && !counts[0]?.includes('…'), JSON.stringify(counts))
const thinkingOpen = snap(<AssistantThinkingMessage thinking={sample} marginTopOnTurn={false} verbose={false} preview streaming={false} />, 100)
assert.equal(thinkingOpen.length, 4, JSON.stringify(thinkingOpen))
assert.ok(!thinkingOpen[0]?.includes('START'))
assert.ok(thinkingOpen.slice(1).some(x => x.includes('BODY_ONLY_')), JSON.stringify(thinkingOpen))
const live = snap(<AssistantThinkingMessage thinking={sample} marginTopOnTurn={false} verbose={false} streaming />, 100)
assert.ok(!live.join('\n').includes('START'), JSON.stringify(live))
// The helper reads source via charCodeAt; neither live branch should touch the
// full source this way. The ticker's split lines differ from the full source.
const readUnit = String.prototype.charCodeAt
try {
  String.prototype.charCodeAt = function(index: number) {
    assert.notEqual(String(this), sample, 'live or thinkingOpen branch scanned settled summary')
    return readUnit.call(this, index)
  }
  snap(<AssistantThinkingMessage thinking={sample} marginTopOnTurn={false} verbose={false} streaming />, 100)
  snap(<AssistantThinkingMessage thinking={sample} marginTopOnTurn={false} verbose={false} preview streaming={false} />, 100)
} finally {
  String.prototype.charCodeAt = readUnit
}
const expanded = snap(<AssistantThinkingMessage thinking={sample} marginTopOnTurn={false} verbose />, 100)
assert.ok(expanded.join('\n').includes('BODY_ONLY_TAIL'), JSON.stringify(expanded))
for (const width of [4, 6, 12, 20, 40, 60]) {
  const output = snap(<AssistantThinkingMessage thinking={'👩‍👩‍👧‍👦e\u0301🇨🇳'.repeat(10)} marginTopOnTurn={false} verbose={false} onClick={() => {}} />, width)
  assert.equal(output.length, 1, `${width}: ${JSON.stringify(output)}`)
}
// Override only in this process; unsafe key bytes must not crash or be painted.
try {
  for (const key of ['\x1b', '\x00', '\x7f', '\x9b']) {
    const unsafe = `ctrl+${key}`
    assert.ok(keymap.parseCombo(unsafe), 'test must exercise a currently accepted combo')
    keymap.setKeymapOverrides({ transcript: unsafe })
    assert.equal(keymap.primaryComboString('transcript'), unsafe)
    const row = snap(<AssistantThinkingMessage thinking="short" marginTopOnTurn={false} verbose={false} onClick={() => {}} />, 100)
    assert.equal(row.length, 1)
    assert.ok(row[0]?.includes('short…') && row[0]?.includes('click to expand'), JSON.stringify(row))
    assert.ok(!row[0]?.includes('ctrl+o'), 'must not fabricate the default binding')
    assert.doesNotMatch(row.join(''), /[\x00-\x1f\x7f-\x9f]/u)
    const noHandler = snap(<AssistantThinkingMessage thinking="short" marginTopOnTurn={false} verbose={false} />, 100)
    assert.equal(noHandler.length, 1)
    assert.ok(noHandler[0]?.includes('short…') && !noHandler[0]?.includes('click to expand'))
    assert.doesNotMatch(noHandler.join(''), /[\x00-\x1f\x7f-\x9f]/u)
  }
  keymap.setKeymapOverrides({ transcript: 'alt+x' })
  const remap = snap(<AssistantThinkingMessage thinking="short" marginTopOnTurn={false} verbose={false} />, 100)
  assert.ok(remap[0]?.includes('alt+x'), JSON.stringify(remap))
} finally {
  keymap.resetKeymapOverrides()
}
console.log('PASS: settled, clickable, selection, count-only, thinkingOpen preview, streaming, expanded, narrow row, and safe keymap hints')
