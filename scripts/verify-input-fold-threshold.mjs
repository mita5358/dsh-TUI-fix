/*
 * Differential check of PromptInput's actual fold-threshold helper.
 * TypeScript transpilation is in-process; no TTY, TSX loader, native child,
 * network, clipboard, session, or user configuration is needed.
 * Run: node scripts/verify-input-fold-threshold.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/components/PromptInput.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('PromptInput.tsx', source, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TSX)
const names = ['FOLD_MIN_LINES', 'FOLD_MIN_CHARS', 'isBigInput']
const statements = new Map()
for (const statement of ast.statements) {
  if (!ts.isVariableStatement(statement)) continue
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)) {
      assert.equal(statement.declarationList.declarations.length, 1, 'threshold declarations must be independently located')
      assert.equal(statements.has(declaration.name.text), false, 'threshold declaration must be unique')
      statements.set(declaration.name.text, statement.getText(ast))
    }
  }
}
assert.deepEqual([...statements.keys()].sort(), [...names].sort(), 'all threshold source declarations must be present')
const input = `${names.map(name => statements.get(name)).join('\n')}\nexport { isBigInput }`
const result = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext }, reportDiagnostics: true })
assert.equal(result.diagnostics?.length ?? 0, 0, 'threshold helper must transpile')
const { isBigInput } = await import(`data:text/javascript;base64,${Buffer.from(result.outputText).toString('base64')}`)
const old = text => text.split('\n').length >= 6 || text.length >= 600
let checked = 0
function compare(text) {
  assert.equal(isBigInput(text), old(text), `threshold mismatch: length=${text.length}`)
  checked++
}
for (const text of [
  '', 'x'.repeat(599), 'x'.repeat(600), 'x'.repeat(601),
  '\n'.repeat(4), '\n'.repeat(5), '\n'.repeat(6),
  'one\ntwo\nthree\nfour\nfive\n', '😀'.repeat(299), '😀'.repeat(300),
  '\ud800'.repeat(599), '\udc00'.repeat(600), '\r\n'.repeat(5),
]) compare(text)
let seed = 0x821a9d5
const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
const units = ['a', '\n', '\r', '界', '😀', '\ud800', '\udc00']
for (let index = 0; index < 2000; index++) {
  let text = ''
  const length = next() % 700
  for (let unit = 0; unit < length; unit++) text += units[next() % units.length]
  compare(text)
}
// A long, ordinary string must short-circuit before allocating its line array.
const originalSplit = String.prototype.split
const sentinel = `unique-threshold-${'z'.repeat(1000)}`
let calls = 0
try {
  String.prototype.split = function (...args) {
    if (String(this) === sentinel) calls++
    return originalSplit.apply(this, args)
  }
  assert.equal(isBigInput(sentinel), true)
  assert.equal(calls, 0, 'a long primitive string must not be split just to decide its size')
} finally {
  String.prototype.split = originalSplit
}
// Preserve the historical failure/side-effect order for malformed host values.
for (const value of [null, undefined, 1, {}, { length: 9999, split() { throw new Error('synthetic split failure') } }]) {
  const outcome = fn => {
    try { return { value: fn(value) } } catch (error) { return { name: error?.name, message: error?.message } }
  }
  assert.deepEqual(outcome(isBigInput), outcome(old))
  checked++
}
const accesses = []
const malformed = {
  get split() {
    accesses.push('split getter')
    return () => { accesses.push('split call'); return { get length() { accesses.push('line count'); return 2 } } }
  },
  get length() { accesses.push('source length'); return 700 },
}
const expectedMalformed = old(malformed)
const expectedAccesses = [...accesses]
accesses.length = 0
assert.equal(isBigInput(malformed), expectedMalformed)
assert.deepEqual(accesses, expectedAccesses, 'malformed host values keep the old property-access order')
checked++
console.log(`input fold threshold: ${checked} differential checks passed`)
