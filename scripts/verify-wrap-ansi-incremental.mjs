/*
 * Compare the actual wrapAnsi TypeScript source with its wrap-ansi dependency.
 * This test uses TypeScript's in-process single-file transpiler only: this
 * standalone module contains no cross-module const enums. No product output
 * is written, and no TSX loader, native child, TTY, session, or network is used.
 * Run: node scripts/verify-wrap-ansi-incremental.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import wrapAnsiNpm from 'wrap-ansi'

const source = readFileSync(new URL('../src/ink/wrapAnsi.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
  reportDiagnostics: true,
})
assert.equal(js.diagnostics?.length ?? 0, 0, 'wrapAnsi must transpile')
const originalImport = "import wrapAnsiNpm from 'wrap-ansi';"
assert.equal(js.outputText.split(originalImport).length, 2, 'expected exactly one dependency import')
const hook = '__dshVerifyWrapAnsiDependency'
assert.equal(Object.hasOwn(globalThis, hook), false, 'test hook collision')
const inputs = []
let corruptNext = false
let throwNext = false
let armJoinAfterDependency = false
let throwJoin = false
globalThis[hook] = (text, ...args) => {
  inputs.push(text)
  if (throwNext) { throwNext = false; throw new Error('synthetic dependency error') }
  const result = wrapAnsiNpm(text, ...args)
  if (armJoinAfterDependency) { armJoinAfterDependency = false; throwJoin = true }
  if (corruptNext) { corruptNext = false; return result.slice(1) }
  return result
}
try {
  const instrumented = js.outputText.replace(originalImport, `const wrapAnsiNpm = globalThis.${hook};`)
  const { wrapAnsi } = await import(`data:text/javascript;base64,${Buffer.from(instrumented).toString('base64')}`)
  let checked = 0
  const clear = () => { wrapAnsi('', 5, { hard: true, trim: false }); inputs.length = 0 }
  const checkSequence = (name, prefix, suffixes, columns, options) => {
    clear()
    let text = prefix
    for (const suffix of ['', ...suffixes]) {
      text += suffix
      const actual = wrapAnsi(text, columns, options)
      const expected = wrapAnsiNpm(text, columns, options)
      assert.equal(actual, expected, `${name}: append ${checked}`)
      checked++
    }
  }

  // This previously reflowed an already cached row when the last word grew.
  checkSequence('last-word reflow', `${'z'.repeat(2050)}a bbbbb`, ['b'], 5, { hard: true, trim: false })
  checkSequence('whitespace', `${'x'.repeat(2050)}  a `, ['b', ' ', 'cccccc', 'd'], 7, { hard: true, trim: false })
  checkSequence('CRLF and tabs', `${'x'.repeat(2050)}\r`, ['\n', '\tword', '\nend'], 8, { hard: true, trim: false })
  checkSequence('C1 SGR', `${'x'.repeat(2050)}\u009b31mred`, [' bold', '\u009b0m'], 10, { hard: true, trim: false })
  checkSequence('split C1 SGR', `${'x'.repeat(2050)}\u009b`, ['31', 'mred', '\u009b0m'], 10, { hard: true, trim: false })
  checkSequence('OSC8 and SGR', `${'x'.repeat(2050)}\u001b]8;;https://example.test\u0007link`, [' more', '\u001b]8;;\u0007'], 10, { hard: true, trim: false })
  checkSequence('combining and emoji', `${'x'.repeat(2050)}e`, ['\u0301', '👩', '\u200d', '💻', '\ud83d', '\udc4d'], 6, { hard: true, trim: false })
  checkSequence('default trim', `${'x'.repeat(2050)}  `, [' x', ' '], 9, { hard: true })
  for (const width of [1, 2, 5, 80]) {
    for (const wordWrap of [undefined, true, false]) {
      checkSequence(`single word width ${width}, wordWrap ${String(wordWrap)}`, 'z'.repeat(2050), ['a', 'b'.repeat(width), 'c'], width, { hard: true, trim: false, wordWrap })
    }
  }
  for (const width of [0, -1, 1.5]) {
    checkSequence(`unusual width ${width}`, 'z'.repeat(2050), ['abc'], width, { hard: true, trim: false })
  }
  // Exercise arbitrary append boundaries, including transitions from eligible
  // ASCII words to whitespace, control sequences, and extended graphemes.
  let seed = 0x4d595df4
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const fragments = ['a', 'Z9', '-', ' ', '  ', '\n', '\r', '\t', '界', '\u0301', '😀', '\u001b[31m', '\u009b0m']
  for (let index = 0; index < 96; index++) {
    const width = 1 + random() % 36
    const mode = [undefined, true, false][random() % 3]
    const suffixes = Array.from({ length: 4 }, () => fragments[random() % fragments.length])
    checkSequence(`generated ${index}`, 'r'.repeat(2049 + random() % 8), suffixes, width, { hard: true, trim: false, wordWrap: mode })
  }
  // Multi-frame ASCII prose: the old final word can span rows and earlier
  // retained rows can begin in the middle of a different hard-wrapped word.
  const proseBases = [
    `${'P'.repeat(2075)} x`,
    `${'P'.repeat(2075)}${' x'.repeat(8)} ${'z'.repeat(89)}`,
    `${' '.repeat(2050)}a bc`,
    `${'A'.repeat(2049)}${' '.repeat(31)}Q`,
    `${'A '.repeat(1025)}abcdefghi`,
    `${' '.repeat(33)}${'A'.repeat(2060)} !?`,
    `${'Q'.repeat(2100)}${' '.repeat(40)}`,
  ]
  for (const width of [1, 3, 5, 17, 80]) {
    for (const wordWrap of [undefined, true, false]) {
      for (const [index, base] of proseBases.entries()) {
        checkSequence(`prose ${width}/${String(wordWrap)}/${index}`, base, ['!', '?1', ' ', ' ', 'END', ' '.repeat(9), 'new-word', '9'.repeat(43)], width, { hard: true, trim: false, wordWrap })
      }
    }
  }
  // Options, widths and unsafe inputs must not reuse a previous slot.
  clear()
  const modePrefix = 'v'.repeat(2050)
  wrapAnsi(modePrefix, 40, { hard: true, trim: false, wordWrap: true })
  inputs.length = 0
  wrapAnsi(`${modePrefix}a`, 40, { hard: true, trim: false, wordWrap: false })
  assert.equal(inputs[0], `${modePrefix}a`, 'changed word-wrap mode must rewrap the complete input')
  inputs.length = 0
  wrapAnsi(`${modePrefix}ab`, 39, { hard: true, trim: false, wordWrap: false })
  assert.equal(inputs[0], `${modePrefix}ab`, 'changed width must rewrap the complete input')
  inputs.length = 0
  wrapAnsi(`${modePrefix}abc`, 39, { hard: true, wordWrap: false })
  assert.equal(inputs[0], `${modePrefix}abc`, 'implicit trim must not reuse the no-trim slot')
  checked += 3
  // Ordinary ASCII prose must retain an incremental path without losing the
  // earlier row that the growing final word can change.
  clear()
  const prosePrefix = `${'alpha beta '.repeat(200)}last`
  wrapAnsi(prosePrefix, 40, { hard: true, trim: false })
  inputs.length = 0
  assert.equal(wrapAnsi(`${prosePrefix}word`, 40, { hard: true, trim: false }), wrapAnsiNpm(`${prosePrefix}word`, 40, { hard: true, trim: false }))
  assert.equal(inputs.length, 1, 'ordinary prose append uses one dependency wrap')
  assert.ok(inputs[0].length < 100, 'ordinary prose append should not rewrap its stable head')
  checked++
  // A cached word must be invalidated as soon as a control sequence arrives.
  clear()
  const unsafePrefix = 'q'.repeat(2050)
  wrapAnsi(unsafePrefix, 40, { hard: true, trim: false })
  inputs.length = 0
  wrapAnsi(`${unsafePrefix}\u009b31m`, 40, { hard: true, trim: false })
  assert.equal(inputs[0], `${unsafePrefix}\u009b31m`, 'control transition must rewrap the complete input')
  inputs.length = 0
  wrapAnsi(`${unsafePrefix}\u009b31mx`, 40, { hard: true, trim: false })
  assert.equal(inputs[0], `${unsafePrefix}\u009b31mx`, 'unsafe input must not seed another slot')
  checked += 2
  // A failing options getter must invalidate any previous slot.
  clear()
  wrapAnsi(unsafePrefix, 40, { hard: true, trim: false })
  assert.throws(() => wrapAnsi(`${unsafePrefix}a`, 40, { get hard() { throw new Error('synthetic options error') }, trim: false }), /synthetic options error/)
  inputs.length = 0
  wrapAnsi(`${unsafePrefix}b`, 40, { hard: true, trim: false })
  assert.equal(inputs[0], `${unsafePrefix}b`, 'failed wrap must not reuse the earlier slot')
  checked++
  // An upstream exception and an internally corrupted tail may not leave or
  // return a stale partial result. The latter must trigger a full fallback.
  clear()
  wrapAnsi(unsafePrefix, 40, { hard: true, trim: false })
  throwNext = true
  assert.throws(() => wrapAnsi(`${unsafePrefix}a`, 40, { hard: true, trim: false }), /synthetic dependency error/)
  inputs.length = 0
  wrapAnsi(`${unsafePrefix}b`, 40, { hard: true, trim: false })
  assert.equal(inputs[0], `${unsafePrefix}b`, 'dependency failure must clear the slot')
  clear()
  wrapAnsi(unsafePrefix, 40, { hard: true, trim: false })
  inputs.length = 0
  corruptNext = true
  assert.equal(wrapAnsi(`${unsafePrefix}c`, 40, { hard: true, trim: false }), wrapAnsiNpm(`${unsafePrefix}c`, 40, { hard: true, trim: false }))
  assert.equal(inputs.length, 2, 'corrupted tail must be followed by a full upstream wrap')
  assert.equal(inputs[1], `${unsafePrefix}c`, 'fallback must receive the complete input')
  checked += 2
  // A failure building the final returned string must not publish a slot.
  clear()
  wrapAnsi(unsafePrefix, 40, { hard: true, trim: false })
  const originalJoin = Array.prototype.join
  try {
    Array.prototype.join = function (separator) {
      if (throwJoin && separator === '\n') { throwJoin = false; throw new Error('synthetic row join error') }
      return originalJoin.call(this, separator)
    }
    inputs.length = 0
    armJoinAfterDependency = true
    assert.throws(() => wrapAnsi(`${unsafePrefix}a`, 40, { hard: true, trim: false }), /synthetic row join error/)
    assert.ok(inputs[0].length < 100, 'failure must be injected after a real cache hit')
  } finally {
    Array.prototype.join = originalJoin
    armJoinAfterDependency = false
    throwJoin = false
  }
  inputs.length = 0
  wrapAnsi(`${unsafePrefix}b`, 40, { hard: true, trim: false })
  assert.equal(inputs[0], `${unsafePrefix}b`, 'failed output join must not publish a stale slot')
  checked++
  // A cached input followed by a non-append replacement must not retain rows.
  clear()
  wrapAnsi('x'.repeat(2100), 11, { hard: true, trim: false })
  const replacement = 'y'.repeat(2101)
  assert.equal(wrapAnsi(replacement, 11, { hard: true, trim: false }), wrapAnsiNpm(replacement, 11, { hard: true, trim: false }))
  checked++
  // Verify that the safe one-word path still wraps only a bounded tail.
  clear()
  const prefix = 'q'.repeat(2050)
  wrapAnsi(prefix, 40, { hard: true, trim: false })
  inputs.length = 0
  assert.equal(wrapAnsi(prefix + 'xyz', 40, { hard: true, trim: false }), wrapAnsiNpm(prefix + 'xyz', 40, { hard: true, trim: false }))
  assert.equal(inputs.length, 1, 'one dependency wrap per append')
  assert.ok(inputs[0].length <= 43, 'safe append should wrap only the preceding tail')
  checked++
  console.log(`wrap-ansi incremental: ${checked} differential checks passed`)
} finally {
  delete globalThis[hook]
}
