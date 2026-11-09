/*
 * Check PromptInput's actual bound-image span selector against the original
 * scan+filter behavior. In-process TS transpilation only; no UI or p95 claim.
 * Run: node scripts/verify-input-bound-images.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const prompt = readFileSync(new URL('../src/components/PromptInput.tsx', import.meta.url), 'utf8')
const imageSource = readFileSync(new URL('../src/components/composerImageTokens.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('PromptInput.tsx', prompt, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TSX)
const selectors = []
const wrappers = []
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'boundImageSpans') selectors.push(node)
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'wrapLineRows') wrappers.push(node)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(selectors.length, 1, 'bound image selector must be unique')
assert.equal(wrappers.length, 1, 'wrapping helper must be unique')
assert.match(wrappers[0].getText(ast), /imageTokenSpans\(line\)/u, 'raw image-looking text must remain unbreakable while wrapping')
const imageJs = ts.transpileModule(imageSource, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext } }).outputText
const imageUrl = `data:text/javascript;base64,${Buffer.from(imageJs).toString('base64')}`
const program = `
import {imageTokenSpans as realImageTokenSpans} from ${JSON.stringify(imageUrl)}
type ImageTokenSpan = {start:number; end:number; token:string}
export function makeSelector(map: Map<string, string>) {
  let scans = 0
  const draftImagesRef = {current: map}
  const imageTokenSpans = (text: string) => { scans++; return realImageTokenSpans(text) }
  const ${selectors[0].getText(ast)}
  return {select: boundImageSpans, getScans: () => scans}
}
export { realImageTokenSpans }
`
const result = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext }, reportDiagnostics: true })
assert.equal(result.diagnostics?.length ?? 0, 0, 'bound selector must transpile')
const { makeSelector, realImageTokenSpans } = await import(`data:text/javascript;base64,${Buffer.from(result.outputText).toString('base64')}`)
const values = [
  '', 'hello', '[Image #1]', 'x [Image #1] y [Image #2]', '[Image #01][Image #1]',
  '[Image #0] [Image #999999999999999999999999]', '[Image #-1] [image #1]',
  '中文🙂 [Image #2]\ne\u0301 [Image #1]', '\ud800[Image #1]\udc00',
]
let seed = 1234567
const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
const parts = ['x', '\n', '界', '🙂', '[Image #1]', '[Image #2]', '[Image #01]', '[bad]', '\ud800']
for (let index = 0; index < 500; index++) {
  let text = ''
  const count = next() % 25
  for (let part = 0; part < count; part++) text += parts[next() % parts.length]
  values.push(text)
}
let checked = 0
for (const live of [[], ['[Image #1]'], ['[Image #2]', '[Image #01]'], ['[Image #9]']]) {
  const map = new Map(live.map((token, index) => [token, `stage-${index}`]))
  const selector = makeSelector(map)
  for (const text of values) {
    assert.deepEqual(selector.select(text), realImageTokenSpans(text).filter(span => map.has(span.token)))
    checked++
  }
}
const map = new Map()
const selector = makeSelector(map)
const text = 'raw [Image #1] text'
for (let row = 0; row < 7; row++) assert.deepEqual(selector.select(text), [])
assert.equal(selector.getScans(), 0, 'no live capabilities must avoid whole-text token scanning')
assert.equal(realImageTokenSpans(text).length, 1, 'raw token still exists for wrap geometry')
map.set('[Image #1]', 'stage-1')
assert.equal(selector.select(text).length, 1, 'a newly bound image must be detected immediately')
assert.equal(selector.getScans(), 1)
map.delete('[Image #1]')
assert.deepEqual(selector.select(text), [], 'a released image must stop being bound immediately')
assert.equal(selector.getScans(), 1)
for (const value of [null, undefined, 5, {}, new String('[Image #1]')]) {
  const outcome = fn => { try { return { value: fn(value) } } catch (error) { return { name: error?.name, message: error?.message } } }
  assert.deepEqual(outcome(selector.select), outcome(input => realImageTokenSpans(input).filter(span => map.has(span.token))))
  checked++
}
console.log(`input bound images: ${checked} synthetic cases passed`)
