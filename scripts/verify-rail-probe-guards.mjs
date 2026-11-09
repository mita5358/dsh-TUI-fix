/*
 * Narrow source-level checks for perf-rail-click's clock bookkeeping and
 * fail-closed scratch/summary guards. This does NOT execute the TUI probe,
 * validate its target or paint observations, or prove filesystem race safety.
 * Run: node scripts/verify-rail-probe-guards.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix as path } from 'node:path'
import ts from 'typescript'

const source = readFileSync(new URL('./perf-rail-click.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('perf-rail-click.tsx', source, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TSX)
const properties = new Map()
const variables = new Map()
const calls = []
const assignments = []
function visit(node) {
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
    const list = properties.get(node.name.text) ?? []
    list.push(node)
    properties.set(node.name.text, list)
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const list = variables.get(node.name.text) ?? []
    list.push(node)
    variables.set(node.name.text, list)
  }
  if (ts.isCallExpression(node)) calls.push(node)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) assignments.push(node)
  ts.forEachChild(node, visit)
}
visit(ast)
const unique = (map, name) => {
  const found = map.get(name) ?? []
  assert.equal(found.length, 1, `${name} must be unique`)
  return found[0]
}
const envGuards = ast.statements.filter(node => ts.isIfStatement(node) && node.expression.getText(ast).includes('process.env.NODE_ENV'))
assert.equal(envGuards.length, 1, 'one production environment sanity guard is required')
assert.ok(envGuards[0].getStart(ast) < unique(variables, 'tempRoot').getStart(ast), 'environment guard must precede scratch creation')
const checkEnvironment = new Function('process', `${envGuards[0].getText(ast)}; return true`)
assert.throws(() => checkEnvironment({env: {}}), /NODE_ENV=production/)
assert.throws(() => checkEnvironment({env: {NODE_ENV: 'production', DSH_TUI_REACT_DEV: '1'}}), /DSH_TUI_REACT_DEV/)
assert.equal(checkEnvironment({env: {NODE_ENV: 'production'}}), true)
const optionGuards = ast.statements.filter(node => ts.isIfStatement(node) && node.expression.getText(ast) === 'process.env.NODE_OPTIONS')
assert.equal(optionGuards.length, 1, 'NODE_OPTIONS preload guard must be present')
assert.ok(optionGuards[0].getStart(ast) < unique(variables, 'tempRoot').getStart(ast))
const checkOptions = new Function('process', `${optionGuards[0].getText(ast)}; return true`)
assert.throws(() => checkOptions({env: {NODE_OPTIONS: '--require=/tmp/unknown'}}), /unset NODE_OPTIONS/)
assert.equal(checkOptions({env: {}}), true)
const dynamicImportsAt = source.indexOf("import('../src/ui.js')")
assert.ok(dynamicImportsAt > 0)
for (const name of ['HOME', 'USERPROFILE', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP']) {
  assert.ok(assignments.some(node => node.left.getText(ast) === `process.env.${name}` && node.getStart(ast) < dynamicImportsAt), `${name} must be redirected before app imports`)
}
const clearInherited = "if (key.toUpperCase().startsWith('DSH_TUI_')) delete process.env[key]"
assert.ok(source.includes(clearInherited), 'inherited DSH_TUI paths must be cleared case-insensitively before app imports')
assert.ok(source.indexOf(clearInherited) < dynamicImportsAt)
const at = unique(properties, 'at').initializer.getText(ast)
assert.equal(at, 'performance.now() - clickStartedAt', 'frame timestamps are click-relative')
const samplePush = calls.filter(node => node.expression.getText(ast) === 'samples.push')
assert.equal(samplePush.length, 1)
const sampleObject = samplePush[0].arguments[0]
assert.ok(ts.isObjectLiteralExpression(sampleObject))
const sampleProperty = name => {
  const found = sampleObject.properties.filter(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === name)
  assert.equal(found.length, 1, `${name} must occur once in the sample`)
  return found[0]
}
const first = sampleProperty('firstFrameMs').initializer.getText(ast)
const last = sampleProperty('lastFrameMs').initializer.getText(ast)
const readFirst = new Function('frames', 'startedAt', `return (${first})`)
const readLast = new Function('frames', 'startedAt', `return (${last})`)
assert.equal(readFirst([{at: 25}, {at: 90}], 1000), 25, 'relative first frame must not subtract t0 again')
assert.equal(readLast([{at: 25}, {at: 90}], 1000), 90, 'relative last frame must not subtract t0 again')
assert.equal(readFirst([], 1000), -1)
assert.equal(readLast([], 1000), -1)
for (const name of ['yogaMs', 'yogaMeasured']) {
  const readTotal = new Function('frames', `return (${sampleProperty(name).initializer.getText(ast)})`)
  assert.equal(readTotal([]), null, `empty frames cannot imply zero ${name}`)
  assert.equal(readTotal([{[name]: null}]), null, `missing phases cannot imply zero ${name}`)
  assert.equal(readTotal([{[name]: 4}, {[name]: 3}]), 7)
}
const runClick = unique(variables, 'runClick')
assert.ok(runClick.initializer && ts.isArrowFunction(runClick.initializer))
const loop = runClick.initializer.body.statements.find(node => ts.isForStatement(node))
assert.ok(loop && ts.isBlock(loop.statement), 'attempt loop must be located')
const beforeWrite = loop.statement.statements.findIndex(node => node.getText(ast).startsWith('stdin.write('))
assert.ok(beforeWrite >= 0)
for (const name of ['revealBefore', 'revealBeforeSync', 'frameStart', 'rowsBefore', 'attempts', 'startedAt']) {
  const index = loop.statement.statements.findIndex(node => node.getText(ast).startsWith(`${name} =`))
  assert.ok(index >= 0 && index < beforeWrite, `${name} baseline must precede click dispatch`)
}
const clearClock = loop.statement.statements.findIndex(node => node.getText(ast).startsWith('clickStartedAt = null'))
const armClock = loop.statement.statements.findIndex(node => node.getText(ast).startsWith('clickStartedAt = startedAt'))
const captureTime = loop.statement.statements.findIndex(node => node.getText(ast).startsWith('startedAt ='))
assert.ok(clearClock >= 0 && clearClock < captureTime && captureTime < armClock && armClock < beforeWrite, 'each attempt must clear then rearm its frame clock')
// Percentiles are fail-closed: published only after this run's own samples
// proved the acceptance contract, and null otherwise. The exploratory values
// stay reported separately so a diagnostic run is still readable.
const summaryStatus = (properties.get('status') ?? []).find(node =>
  node.initializer.getText(ast) === "verified ? 'verified' : 'exploratory-unverified'")
assert.ok(summaryStatus, 'summary must advertise verified vs unverified status')
for (const name of ['materializeP95', 'landedP95']) {
  const initializer = unique(properties, name).initializer
  assert.ok(ts.isConditionalExpression(initializer), `${name} must be gated on verification`)
  assert.equal(initializer.whenFalse.kind, ts.SyntaxKind.NullKeyword, `${name} must stay null when unverified`)
}
const conditionalOnly = unique(properties, 'conditionalPercentilesOnly').initializer
assert.ok(ts.isPrefixUnaryExpression(conditionalOnly) && conditionalOnly.getText(ast) === '!verified', 'conditionalPercentilesOnly must follow verification')
const verifiedInit = unique(variables, 'verified').initializer.getText(ast)
for (const proof of ['landedExact', 'unloadedBefore', "revealedKind === 'user'", 'samples.length === CLICKS']) {
  assert.ok(verifiedInit.includes(proof), `verification must require ${proof}`)
}
const summaryNames = ['requested', 'failedRequest', 'unrecordedRequests', 'attemptsTotal', 'retriedSamples', 'materializeNotObserved', 'landingNotObserved', 'landingUnstableOrInexact']
for (const name of summaryNames) assert.ok(properties.has(name), `${name} must be reported`)
const summaryObject = summaryStatus.parent
assert.ok(ts.isObjectLiteralExpression(summaryObject))
const summaryFields = summaryNames.map(name => {
  const found = summaryObject.properties.filter(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === name)
  assert.equal(found.length, 1, `${name} must occur once in the summary`)
  return `${name}: (${found[0].initializer.getText(ast)})`
}).join(',')
const summarize = new Function('CLICKS', 'samples', 'failedRequest', 'materialize', 'landed', `return {${summaryFields}}`)
const one = [{attempts: 2, clickToLandedMs: 12, landedExact: false}]
const incomplete = summarize(3, one, {label: 'click-2', recorded: false, message: 'failed'}, [10], [12])
assert.deepEqual([incomplete.requested, incomplete.unrecordedRequests, incomplete.attemptsTotal, incomplete.retriedSamples, incomplete.landingUnstableOrInexact], [3, 2, null, 1, 1])
const recordedFailure = summarize(3, one, {label: 'click-1', recorded: true, message: 'failed'}, [10], [12])
assert.equal(recordedFailure.attemptsTotal, 2)
const verboseAfterSummary = source.indexOf("if (process.env.VERBOSE === '1')", summaryStatus.getEnd())
assert.ok(verboseAfterSummary > summaryStatus.getEnd())
assert.ok(assignments.some(node => node.left.getText(ast) === 'process.exitCode' && node.right.getText(ast) === '1' && node.getStart(ast) > summaryStatus.getEnd() && node.getEnd() < verboseAfterSummary), 'unverified summary must itself set a failing exit status')
const removal = calls.filter(node => node.expression.getText(ast) === 'rmSync')
assert.equal(removal.length, 1)
assert.equal(removal[0].arguments[0].getText(ast), 'scratch')
assert.doesNotMatch(removal[0].arguments[1].getText(ast), /force\s*:\s*true/u)
assert.ok(ts.isBlock(removal[0].parent.parent))
const removalBlock = removal[0].parent.parent.statements
const removeIndex = removalBlock.findIndex(statement => statement.getText(ast).startsWith('rmSync('))
const verifyIndex = removalBlock.findIndex(statement => statement.getText(ast).startsWith('verifyScratch()'))
assert.ok(verifyIndex >= 0 && removeIndex > verifyIndex, 'scratch identity must be checked immediately before removal')
const createdCall = calls.find(node => node.expression.getText(ast) === 'verifyScratch' && node.getStart(ast) < source.indexOf('writeFileSync(tracePath'))
assert.ok(createdCall, 'scratch must be checked before the first trace write')

const guard = unique(variables, 'verifyScratch')
const declaration = `const ${guard.getText(ast)}`
const guardProgram = `export function makeGuard(tempRoot, parentIdentity, scratch, scratchIdentity, lstatSync, realpathSync, dirname, basename, process) { ${declaration}; return verifyScratch }`
const compiled = ts.transpileModule(guardProgram, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext }, reportDiagnostics: true })
assert.equal(compiled.diagnostics?.length ?? 0, 0)
const { makeGuard } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`)
const directory = (dev, ino, uid = 1000n, mode = 0o40700n, isDirectory = true) => ({ dev, ino, uid, mode, isDirectory: () => isDirectory })
const parent = directory(1n, 2n, 0n, 0o41777n)
const original = directory(1n, 3n)
function guardFor({root = '/virtual', scratch = '/virtual/dsh-rail-perf-ABC', parentNow = parent, scratchNow = original, parentCreated = parent, scratchCreated = original, canonical = scratch, uid = 1000} = {}) {
  const stat = (target, options) => {
    assert.equal(options.bigint, true)
    if (target === root) return parentNow
    if (target === scratch) return scratchNow
    throw new Error('unexpected stat path')
  }
  return makeGuard(root, parentCreated, scratch, scratchCreated, stat, () => canonical, path.dirname, path.basename, {platform: 'linux', getuid: () => uid})
}
assert.doesNotThrow(guardFor())
const initiallyPublic = directory(1n, 3n, 1000n, 0o40755n)
const initiallyOtherOwner = directory(1n, 3n, 1001n)
const initiallyNotDirectory = directory(1n, 3n, 1000n, 0o40700n, false)
for (const changed of [
  {scratchNow: initiallyPublic, scratchCreated: initiallyPublic},
  {scratchNow: initiallyOtherOwner, scratchCreated: initiallyOtherOwner},
  {scratchNow: initiallyNotDirectory, scratchCreated: initiallyNotDirectory},
  {scratchNow: directory(1n, 4n)}, {scratchNow: directory(2n, 3n)},
  {scratchNow: directory(1n, 3n, 1001n)}, {scratchNow: directory(1n, 3n, 1000n, 0o40755n)},
  {scratchNow: directory(1n, 3n, 1000n, 0o40700n, false)},
  {parentNow: directory(1n, 8n, 0n, 0o41777n)}, {canonical: '/other/path'},
  {scratch: '/other/dsh-rail-perf-ABC'}, {scratch: '/virtual/unrelated'}, {uid: 1001},
]) assert.throws(guardFor(changed), /refusing unsafe scratch path/)

// The focused window-seek regression also creates a private scratch tree.
// Inspect its actual guard separately; this still does not execute its UI.
const windowSource = readFileSync(new URL('./verify-rail-window-seek.tsx', import.meta.url), 'utf8')
const windowAst = ts.createSourceFile('verify-rail-window-seek.tsx', windowSource, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TSX)
let windowGuard
const windowCalls = []
function visitWindow(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'verifyScratch') {
    assert.equal(windowGuard, undefined, 'window guard must be unique')
    windowGuard = node
  }
  if (ts.isCallExpression(node)) windowCalls.push(node)
  ts.forEachChild(node, visitWindow)
}
visitWindow(windowAst)
assert.ok(windowGuard)
const windowGuardProgram = `export function makeGuard(tempRoot, parentIdentity, scratch, scratchIdentity, lstatSync, realpathSync, dirname, basename, process) { const ${windowGuard.getText(windowAst)}; return verifyScratch }`
const windowCompiled = ts.transpileModule(windowGuardProgram, { compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext }, reportDiagnostics: true })
assert.equal(windowCompiled.diagnostics?.length ?? 0, 0)
const windowFactory = (await import(`data:text/javascript;base64,${Buffer.from(windowCompiled.outputText).toString('base64')}`)).makeGuard
const windowPath = '/virtual/dsh-rail-window-seek-ABC'
const windowStat = (target, options) => {
  assert.equal(options.bigint, true)
  if (target === '/virtual') return parent
  if (target === windowPath) return original
  throw new Error('unexpected stat path')
}
const windowGuardFor = (scratchPath = windowPath, canonical = scratchPath, expected = original) =>
  windowFactory('/virtual', parent, scratchPath, expected, (target, options) => {
    assert.equal(options.bigint, true)
    return target === scratchPath ? original : windowStat(target, options)
  }, () => canonical, path.dirname, path.basename, {platform: 'linux', getuid: () => 1000})
assert.doesNotThrow(windowGuardFor())
assert.throws(windowGuardFor(windowPath, '/other/path'), /refusing unsafe scratch path/)
assert.throws(windowGuardFor(windowPath, windowPath, directory(1n, 55n)), /refusing unsafe scratch path/)
assert.throws(windowGuardFor('/virtual/not-a-window-probe'), /refusing unsafe scratch path/)
const unsafeWindow = directory(1n, 3n, 1000n, 0o40755n)
const unsafeWindowStat = target => target === '/virtual' ? parent : unsafeWindow
assert.throws(windowFactory('/virtual', parent, windowPath, unsafeWindow, unsafeWindowStat, value => value, path.dirname, path.basename, {platform: 'linux', getuid: () => 1000}), /refusing unsafe scratch path/)
const windowRemoval = windowCalls.filter(node => node.expression.getText(windowAst) === 'rmSync')
assert.equal(windowRemoval.length, 1)
assert.equal(windowRemoval[0].arguments[0].getText(windowAst), 'scratch')
assert.doesNotMatch(windowRemoval[0].arguments[1].getText(windowAst), /force\s*:\s*true/u)
assert.ok(ts.isBlock(windowRemoval[0].parent.parent))
const windowRemovalBlock = windowRemoval[0].parent.parent.statements
const windowVerifyIndex = windowRemovalBlock.findIndex(node => node.getText(windowAst).startsWith('verifyScratch()'))
const windowRemoveIndex = windowRemovalBlock.findIndex(node => node.getText(windowAst).startsWith('rmSync('))
assert.ok(windowVerifyIndex >= 0 && windowRemoveIndex > windowVerifyIndex, 'window scratch identity must be checked before removal')
const firstWindowWrite = windowCalls.filter(node => node.expression.getText(windowAst) === 'mkdirSync').reduce((min, node) => Math.min(min, node.getStart(windowAst)), Infinity)
assert.ok(windowCalls.some(node => node.expression.getText(windowAst) === 'verifyScratch' && node.getStart(windowAst) < firstWindowWrite), 'window scratch must be checked before writing')
const windowImports = windowSource.indexOf("import('../src/ui.js')")
assert.ok(windowImports > 0 && windowSource.indexOf(clearInherited) < windowImports, 'window regression must clear inherited DSH_TUI flags before app imports')
assert.ok(!windowSource.includes('for (const [key, value] of previous)'), 'teardown must not restore inherited user paths')
console.log('rail probe guards: source clocks, invalid summary and synthetic identity checks passed')
