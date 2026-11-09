/*
 * Verify the actual streaming tail helper's no-cut boundary. This narrow
 * source-level regression is not a rendered-screen or full-stream test.
 * If clipping is removed, migrate this check rather than preserving the helper.
 * Run: node scripts/verify-streaming-tail-boundary.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { marked } from 'marked'

const source = readFileSync(new URL('../src/components/StreamingMarkdown.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('StreamingMarkdown.tsx', source, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TSX)
const names = ['SUFFIX_TAIL_BUDGET', 'SUFFIX_BOUNDARY_LOOKBACK', 'SUFFIX_CUT_STEP']
const statements = new Map()
let helper
for (const statement of ast.statements) {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)) {
        assert.equal(statement.declarationList.declarations.length, 1, 'tail constants need separate declarations')
        assert.equal(statements.has(declaration.name.text), false, 'tail constant must be unique')
        statements.set(declaration.name.text, statement.getText(ast))
      }
    }
  }
  if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'clipSuffixTail') {
    assert.equal(helper, undefined, 'tail helper must be unique')
    helper = statement.getText(ast)
  }
}
assert.deepEqual([...statements.keys()].sort(), [...names].sort(), 'all source tail constants must be located')
assert.ok(helper, 'the actual source tail helper must be located')
const input = `function factory(t: (key: string, values: { count: number }) => string) {\n${names.map(name => statements.get(name)).join('\n')}\n${helper}\nreturn clipSuffixTail\n}`
const compiled = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext }, reportDiagnostics: true })
assert.equal(compiled.diagnostics?.length ?? 0, 0, 'tail helper must transpile')
const factory = new Function(`${compiled.outputText}\nreturn factory`)()
let calls = 0
const clip = factory((_key, values) => { calls++; return `[dropped ${values.count}]` })
for (const length of [0, 3584, 3585, 4000, 4608]) {
  const suffix = 'x'.repeat(length)
  const cut = { current: 0 }
  const before = calls
  assert.equal(clip(suffix, cut), suffix, `uncut suffix ${length} must remain exact`)
  assert.equal(cut.current, 0, `uncut suffix ${length} must retain zero cut`)
  assert.equal(calls, before, `uncut suffix ${length} must not create a marker`)
}
const replacement = 'y'.repeat(4000)
const staleCut = { current: 6416 }
assert.equal(clip(replacement, staleCut), replacement, 'a cut beyond a replacement suffix cannot hide it')
assert.equal(staleCut.current, 0, 'an out-of-range cut must be cleared')
const atEndCut = { current: 4000 }
assert.equal(clip(replacement, atEndCut), replacement, 'a cut at the replacement end cannot hide everything')
assert.equal(atEndCut.current, 0, 'a cut at a nonempty suffix end must be cleared')
const longReplacement = 'z'.repeat(5000)
const oversizedCut = { current: 9000 }
const beforeReplacementCalls = calls
const replacementShown = clip(longReplacement, oversizedCut)
assert.ok(oversizedCut.current < longReplacement.length, 'a replacement must not retain an out-of-range cut')
if (oversizedCut.current === 0) {
  assert.equal(replacementShown, longReplacement, 'an unfolded replacement must remain exact')
  assert.equal(calls, beforeReplacementCalls)
} else {
  assert.equal(replacementShown, `[dropped ${oversizedCut.current}]\n\n${longReplacement.slice(oversizedCut.current)}`)
  assert.equal(calls, beforeReplacementCalls + 1)
}
// Do not require clipping of over-budget text: full streaming is the goal.

// Once the stable prefix advances, a cut measured from the old suffix has a
// different origin. Check the actual advancement block and replay that reset
// with the real lexer/helper. A future refactor must update this test rather
// than silently treating unrelated source offsets as interchangeable.
const advances = []
function visit(node) {
  if (ts.isIfStatement(node) && node.expression.getText(ast) === 'stableBoundary.safe' && ts.isBlock(node.thenStatement)) advances.push(node.thenStatement)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(advances.length, 1, 'stable-boundary advancement block must be unique')
const body = advances[0].statements
const resetIndex = body.findIndex(statement => statement.getText(ast).replace(/;$/u, '') === 'cutRef.current = 0')
const prefixIndex = body.findIndex(statement => statement.getText(ast).startsWith('prefixRef.current = stripped.substring('))
assert.ok(prefixIndex >= 0, 'source boundary advancement must be located')
const oldSource = 'x'.repeat(5000)
// Exercise a stale offset produced by the legacy clipper without requiring
// future implementations to keep creating such cuts.
const oldCut = { current: 1416 }
const advanced = `${oldSource}\n\n${'y'.repeat(4000)}`
const tokens = marked.lexer(advanced)
assert.deepEqual(tokens.map(token => token.type), ['paragraph', 'space', 'paragraph'])
const prefixLength = tokens.slice(0, 2).reduce((sum, token) => sum + token.raw.length, 0)
assert.equal(prefixLength, oldSource.length + 2)
if (resetIndex >= 0 && resetIndex < prefixIndex) new Function('cutRef', body[resetIndex].getText(ast))(oldCut)
const newSuffix = advanced.substring(prefixLength)
assert.equal(clip(newSuffix, oldCut), newSuffix, 'old source cut must not remove the new suffix head')
assert.equal(oldCut.current, 0)
assert.ok(resetIndex >= 0 && prefixIndex > resetIndex, 'cut must reset before its source boundary advances')
console.log('streaming tail boundary: zero-cut and advanced-source checks passed')
