/*
 * Narrow regression for PromptInput's original-value grapheme walk.
 * Transpiles the actual source helper and the four actual key arms in-process.
 * It does not mount React/Ink, exercise IME, or measure end-to-end latency.
 * Run: node scripts/verify-input-grapheme-lazy.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const prompt = readFileSync(new URL('../src/components/PromptInput.tsx', import.meta.url), 'utf8')
const intl = readFileSync(new URL('../src/utils/intl.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('PromptInput.tsx', prompt, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TSX)
const helpers = new Map()
const handlers = []
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name && ['graphemeBoundaries', 'previousGraphemeBoundary', 'nextGraphemeBoundary'].includes(node.name.text)) {
    assert.equal(helpers.has(node.name.text), false)
    helpers.set(node.name.text, node.getText(ast))
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useInput' && ts.isArrowFunction(node.arguments[0])) handlers.push(node.arguments[0])
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(handlers.length, 1, 'the actual input handler must be unique')
assert.ok(ts.isBlock(handlers[0].body))
assert.equal(helpers.size, 3, 'the actual grapheme helpers must be located')
const body = handlers[0].body.statements
const selectIf = condition => {
  const found = body.filter(node => ts.isIfStatement(node) && node.expression.getText(ast) === condition)
  assert.equal(found.length, 1, `expected one ${condition} arm`)
  return found[0].getText(ast)
}
const earlySelection = selectIf('(key.backspace || key.delete) && selection')
const arms = ['key.leftArrow', 'key.rightArrow', 'key.backspace && !key.meta', 'key.delete'].map(selectIf)
const eager = body.filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => ts.isIdentifier(decl.name) && decl.name.text === 'bounds'))
assert.ok(eager.length <= 1, 'old-value boundary declaration must be unique')
const eagerText = eager[0]?.getText(ast) ?? ''
const baselineArms = arms.map(arm => arm.replaceAll('graphemeBoundaries(value)', 'bounds'))
const intlJs = ts.transpileModule(intl, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText
const intlUrl = `data:text/javascript;base64,${Buffer.from(intlJs).toString('base64')}`
const implementation = helpers.get('graphemeBoundaries').replace('function graphemeBoundaries(', 'function graphemeBoundariesImpl(')
assert.notEqual(implementation, helpers.get('graphemeBoundaries'), 'must rename the extracted helper exactly once')
function build(eagerDeclaration, keyArms) {
  const program = `
import {getGraphemeSegmenter} from ${JSON.stringify(intlUrl)}
${implementation}
${helpers.get('previousGraphemeBoundary')}
${helpers.get('nextGraphemeBoundary')}
export function simulate(value, cursor, selection, key) {
  let scans = 0
  const actions = []
  const selectionRef = {current: selection}
  const helpOpen = false
  const graphemeBoundaries = text => { scans++; return graphemeBoundariesImpl(text) }
  const setInput = (...args) => { actions.push(['setInput', ...args]) }
  const deleteInputRange = (...args) => { actions.push(['deleteInputRange', ...args]) }
  const setSelectedCommand = value => { actions.push(['setSelectedCommand', value]) }
  const setFileSelected = value => { actions.push(['setFileSelected', value]) }
  const onBackgroundRequest = () => { actions.push(['onBackgroundRequest']) }
  ;(() => {
    ${earlySelection}
    ${eagerDeclaration}
    ${keyArms.join('\n')}
  })()
  return {actions, scans}
}`
  const compiled = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext }, reportDiagnostics: true })
  assert.equal(compiled.diagnostics?.length ?? 0, 0, 'extracted key arms must transpile')
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`)
}
const actual = (await build(eagerText, arms)).simulate
const baseline = (await build('const bounds = graphemeBoundaries(value)', baselineArms)).simulate
const texts = [
  '', 'a', 'hello world', '中文🙂e\u0301', '👨‍👩‍👧‍👦👍🏽🇨🇳',
  'a\n\nb', '\ud800x\udc00', 'x'.repeat(602), '👩🏽‍💻 '.repeat(15),
]
const keys = [
  {}, {leftArrow: true}, {rightArrow: true}, {backspace: true},
  {delete: true}, {backspace: true, meta: true},
]
let checked = 0
for (const text of texts) {
  const cursors = [...new Set([-2, 0, 1, Math.floor(text.length / 2), text.length, text.length + 2])]
  const selections = [null, {start: 0, end: text.length}]
  for (const cursor of cursors) for (const selection of selections) for (const key of keys) {
    const got = actual(text, cursor, selection, key)
    const before = baseline(text, cursor, selection, key)
    assert.deepEqual(got.actions, before.actions, `key behavior differs for ${JSON.stringify({text, cursor, selection, key})}`)
    checked++
  }
}
assert.equal(actual('ordinary input', 3, null, {}).scans, 0, 'ordinary typing must not segment the old value before its own path')
assert.equal(actual('e\u0301🙂', 2, {start: 0, end: 2}, {leftArrow: true}).scans, 0, 'selection collapse must not segment the old value')
assert.equal(actual('e\u0301🙂', 0, null, {backspace: true}).scans, 0, 'backspace at start must not segment the old value')
assert.equal(actual('e\u0301🙂', 2, null, {leftArrow: true}).scans, 1, 'grapheme movement still segments the old value')
console.log(`input grapheme lazy: ${checked} synthetic key cases passed`)
