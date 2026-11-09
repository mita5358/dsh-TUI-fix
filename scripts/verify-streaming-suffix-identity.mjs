/*
 * Verify the actual StreamingMarkdown suffix selector against repeated source
 * spans. This is a narrow source/lexer regression, not a rendered-screen,
 * copy, long-stream, or end-to-end test. No TSX loader or child is used.
 * If the selector is replaced by a full-source streaming renderer, migrate
 * this check to the real rendered-output regression instead of preserving it.
 * Run: node scripts/verify-streaming-suffix-identity.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { marked } from 'marked'

const source = readFileSync(new URL('../src/components/StreamingMarkdown.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('StreamingMarkdown.tsx', source, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TSX)
const matches = []
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'hasDistinctSuffix') matches.push(node)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.equal(matches.length, 1, 'the source suffix selector must be located exactly once')
assert.ok(matches[0].initializer, 'the source suffix selector needs an initializer')
// The actual expression is evaluated in isolation; a future refactor that
// changes its dependencies fails loudly instead of silently skipping coverage.
const expression = matches[0].initializer.getText(ast)
const select = new Function('unstableSuffix', 'stablePrefix', `return (${expression})`)

const first = 'REPEAT\n\nREPEAT'
const tokens = marked.lexer(first)
assert.deepEqual(tokens.map(token => token.type), ['paragraph', 'space', 'paragraph'])
const stablePrefix = tokens.slice(0, 2).map(token => token.raw).join('')
assert.equal(stablePrefix, 'REPEAT\n\n')
const later = `${first}\n\n---\nTAIL`
const suffix = later.substring(stablePrefix.length)
assert.ok(suffix.startsWith(stablePrefix), 'fixture must hit equal text in different source spans')
assert.deepEqual(marked.lexer(suffix).map(token => token.type), ['paragraph', 'space', 'hr', 'paragraph'])
assert.equal(select(suffix, stablePrefix), true, 'equal bytes at different source offsets are not overlap')
assert.equal(select('same', 'same'), true, 'identical nonempty prefix and suffix still denote separate spans')
assert.equal(select('text', ''), true, 'a nonempty initial suffix remains visible')
assert.equal(select('', 'prefix'), false, 'an empty suffix remains absent')
console.log('streaming suffix identity: repeated source spans stay distinct')
