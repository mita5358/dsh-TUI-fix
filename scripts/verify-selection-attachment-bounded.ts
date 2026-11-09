/** Selection attachment replay must keep legacy results without splitting large bodies.
 * Run: node --import tsx/esm scripts/verify-selection-attachment-bounded.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { replaySelectionAttachment } from '../src/channel/selection-record.js'

function oracle(content: readonly unknown[] | undefined) {
  if (content === undefined) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as { type?: unknown; text?: unknown }).text
    if ((block as { type?: unknown }).type !== 'text' || typeof text !== 'string') continue
    const opened = /^<attached-file path="([^"]+)" selection(?: count="(\d+)")?>\n/.exec(text)
    if (opened === null) continue
    let closed = text.slice(opened[0].length)
    if (closed.endsWith('</attached-file>')) closed = closed.slice(0, -'</attached-file>'.length)
    if (closed.endsWith('\n')) closed = closed.slice(0, -1)
    const lines = closed.split('\n').length
    const counted = opened[2] === undefined ? undefined : Number(opened[2])
    return { lines: counted ?? (closed.endsWith('\n[… truncated]') ? lines - 1 : lines), path: opened[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') }
  }
  return undefined
}
const compare = (content: unknown) => {
  const run = (fn: typeof oracle) => {
    try { return { ok: true as const, value: fn(content as readonly unknown[] | undefined) } }
    catch (error) { return { ok: false as const, name: error instanceof Error ? error.name : typeof error } }
  }
  assert.deepEqual(run(replaySelectionAttachment), run(oracle))
}
const bodies = ['', '\n', '\n\n', 'a\n', 'a\r\n', '\n[… truncated]', 'a\n[… truncated]\n</attached-file>', '[… truncated]', 'x</attached-file>extra', '\ud800', '🐋\n汉']
const paths = ['x', '&lt;&gt;&quot;&amp;', '&amp;lt;', 'x\n[… truncated]', '', 'bad"quote']
const counts = ['', ' count="0"', ' count="0003"', ` count="${'9'.repeat(400)}"`, ' count="-1"', ' count="1.5"', ' count=""']
for (const body of bodies) for (const path of paths) for (const count of counts) {
  compare([{ type: 'text', text: `<attached-file path="${path}" selection${count}>\n${body}` }])
}
for (const value of [undefined, null, 5, 'not-an-array', [], [null, {}, { type: 'text', text: 3 }], [
  { type: 'text', text: '<attached-file path="a" selection count="0">\nx' },
  { type: 'text', text: '<attached-file path="b" selection>\ny' },
]]) compare(value)
let seed = 0x2468ace0
const alphabet = ['a', '\n', '\r', '汉', '🐋', '\ud800', '<', '>', '/', ' ', '[… truncated]', '</attached-file>']
for (let n = 0; n < 3000; n++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  const length = seed % 32
  let body = ''
  for (let i = 0; i < length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; body += alphabet[seed % alphabet.length] }
  compare([{ type: 'text', text: `<attached-file path="x&amp;lt;" selection${n % 2 ? ' count="12"' : ''}>\n${body}` }])
}
// Execute the actual source in a separate JS realm so the split observer cannot
// affect the host or any application code. The literal original is a positive control.
const source = readFileSync(new URL('../src/channel/selection-record.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const context = vm.createContext({ module: { exports: {} }, exports: {} })
vm.runInContext('module.exports = exports', context)
vm.runInContext(js, context)
vm.runInContext(`globalThis.original = ${oracle.toString()}`, context)
vm.runInContext(`
  const split = String.prototype.split
  globalThis.splitCalls = 0
  String.prototype.split = function (...args) {
    if (args[0] === '\\n') globalThis.splitCalls++
    return split.apply(this, args)
  }
  globalThis.run = (text, useOriginal) => {
    globalThis.splitCalls = 0
    const fn = useOriginal ? globalThis.original : module.exports.replaySelectionAttachment
    const value = fn([{ type: 'text', text }])
    return { value, calls: globalThis.splitCalls }
  }
`, context)
const run = context.run as (text: string, useOriginal: boolean) => { value: { lines: number }; calls: number }
const body = 'x\n'.repeat(262144)
const counted = `<attached-file path="x" selection count="262144">\n${body}</attached-file>`
const control = run(counted, true)
assert.equal(control.value.lines, 262144)
assert.ok(control.calls > 0, 'observer must detect the original split')
const result = run(counted, false)
assert.equal(result.value.lines, 262144)
assert.equal(result.calls, 0, 'authoritative count must not split the attachment body')
const uncounted = `<attached-file path="x" selection>\n${body}</attached-file>`
const legacyControl = run(uncounted, true)
assert.equal(legacyControl.value.lines, 262144)
assert.ok(legacyControl.calls > 0, 'observer must detect the original legacy split')
const legacyResult = run(uncounted, false)
assert.equal(legacyResult.value.lines, 262144)
assert.equal(legacyResult.calls, 0, 'legacy replay must count lines without splitting the body')
console.log('PASS selection replay differential and bounded body handling')
