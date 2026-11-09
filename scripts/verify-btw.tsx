/**
 * Headless verification for /btw side-question overlay: renders the Chat screen
 * against a fake channel and exercises the six contracts —
 *  1. idle trigger opens the overlay and streams the answer in,
 *  2. a working channel still opens it (no steer into the running turn),
 *  3. Space dismisses it,
 *  4. bare /btw notifies usage,
 *  5. wrapSideQuestion/runSideQuestion behave over a fake chunk stream
 *     (assembled answer + abort short-circuit),
 *  6. an unresolved tool call in the derived tail never reaches the request,
 *     and the wrapper names it as still running instead — but only a call of
 *     the open step; a closed step's orphan is dropped without the note.
 * Run: node --import tsx/esm scripts/verify-btw.tsx
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settled, screenHas, viewportLines } from './lib/term-test.mjs'

// Set these before importing the application, even when invoked outside CI.
// Ignore inherited trace/session paths and temp overrides that may point home.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('DSH_TUI_')) delete process.env[key]
}
delete process.env.TMPDIR
delete process.env.TMP
delete process.env.TEMP
const fixtureHome = mkdtempSync(join(tmpdir(), 'verify-btw-'))
process.env.HOME = fixtureHome
process.env.USERPROFILE = fixtureHome
process.env.DSH_HOME = join(fixtureHome, '.dsh')
process.env.XDG_CONFIG_HOME = join(fixtureHome, '.config')
process.env.XDG_CACHE_HOME = join(fixtureHome, '.cache')
process.env.XDG_DATA_HOME = join(fixtureHome, '.local', 'share')
process.env.XDG_STATE_HOME = join(fixtureHome, '.local', 'state')
process.on('exit', () => rmSync(fixtureHome, { recursive: true, force: true }))
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { LOCAL_COMMANDS }, { wrapSideQuestion, runSideQuestion, splitUnresolvedToolCalls, openStepToolCallIds }, { applySidePanelPanels }, { btwThreads }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/dsh-adapter/sideQuestion.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('../src/components/sidePanel/btw/threads.js'),
])

// This script exercises the fallback overlay. The default now enables btw;
// the enabled-panel route has its own verify-btw-panel.tsx regression.
applySidePanelPanels('todo,jobs,agents')

class FakeStdout extends Writable {
  columns = 100
  rows = 28
  isTTY = true
  term = new XTerm({ cols: this.columns, rows: this.rows, allowProposedApi: true })
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    // Writable completion follows xterm parsing, not just enqueueing the bytes.
    this.term.write(String(chunk), callback)
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

/** Fake channel in smoke.tsx's shape, plus the btw seams. */
function makeChannel() {
  let stream: ((delta: string) => void) | undefined
  let finish: ((result: { answer: string | null }) => void) | undefined
  return {
    version: 0,
    whaleIdle: false, // 探针确定性：鲸鱼闲置动画不进测量窗口
    rows: [],
    status: 'idle' as const,
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 120, output: 45 },
    cwd: 'C:/code/demo-project',
    displayCwd: 'C:/code/demo-project',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting' as const,
    mode: { plan: false },
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    commandList: LOCAL_COMMANDS,
    commandCompletions: () => [],
    notifications: [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe: () => () => {},
    submitCalls: [] as string[],
    steerCalls: [] as string[],
    notifyCalls: [] as string[],
    sideCalls: [] as string[],
    sideDeltas: [] as string[],
    submit(text: string) { this.submitCalls.push(text) },
    steer(text: string) { this.steerCalls.push(text) },
    cancel() {},
    clear() {},
    notify(text: string) { this.notifyCalls.push(text) },
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
    sideQuestion(question: string, options?: { onText?: (delta: string) => void }): Promise<{ answer: string | null }> {
      this.sideCalls.push(question)
      stream = options?.onText
      return new Promise(resolve => { finish = resolve })
    },
    emit(delta: string) {
      assert.ok(stream, 'side question must start before emitting')
      this.sideDeltas.push(delta)
      stream(delta)
    },
    finish() {
      assert.ok(finish, 'side question must start before finishing')
      finish({ answer: 'The answer is **42**.' })
      finish = undefined
      stream = undefined
    },
  }
}

// ── Scenario 1: idle trigger opens the overlay and streams the answer ──
{
  const channel = makeChannel()
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const instance = await render(
    <Chat channel={channel as never} questionStore={new QuestionStore()} />,
    { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  const screen = () => viewportLines(stdout.term).join('\n')
  const diagnostics = () => JSON.stringify({ screen: screen(), notifications: channel.notifyCalls, submits: channel.submitCalls, steers: channel.steerCalls, sideCalls: channel.sideCalls, sideDeltas: channel.sideDeltas })
  const has = (text: string) => screenHas(stdout.term, text)
  assert.ok(await settled(() => screen().trim().length > 0), 'initial screen must render')
  stdin.write('/btw what is the answer?')
  assert.ok(await settled(() => has('/btw what is the answer?')), `command must reach composer: ${diagnostics()}`)
  stdin.write('\r')
  const opened = await settled(() => has('what is the answer?') && !has('/btw what is the answer?') && channel.sideCalls.includes('what is the answer?'))
  assert.ok(opened, `side question must open: ${diagnostics()}`)
  channel.emit('The answer is ')
  assert.ok(await settled(() => has('The answer is')), `first streamed delta must be visible before completion: ${diagnostics()}`)
  channel.emit('**42**.')
  const streamed = await settled(() => has('The answer is') && has('42'))
  assert.ok(streamed, `streamed answer must be visible before completion: ${diagnostics()}`)
  channel.finish()
  assert.ok(await settled(() => btwThreads.get(channel.agentId)?.turns.at(-1)?.phase === 'completed'), `side question must complete: ${diagnostics()}`)
  const noTranscript = channel.submitCalls.length === 0 && channel.steerCalls.length === 0
  assert.ok(noTranscript, `side question must leave the transcript untouched: ${diagnostics()}`)
  console.log('scenario1 idle trigger opens + streams + leaves transcript untouched:', opened, streamed, noTranscript)

  // ── Scenario 2: Space dismisses, then /btw on a working channel ──────
  stdin.write(' ')
  const closedOk = await settled(() => !has('what is the answer?'))
  assert.ok(closedOk, `Space must close the current screen: ${diagnostics()}`)
  channel.working = true
  stdin.write('/btw again?')
  assert.ok(await settled(() => has('/btw again?')), `working command must reach composer: ${diagnostics()}`)
  stdin.write('\r')
  assert.ok(await settled(() => has('again?') && !has('/btw again?') && channel.sideCalls.some(question => question.endsWith('again?'))), `working side question must open: ${diagnostics()}`)
  channel.emit('The answer is ')
  channel.emit('**42**.')
  // The fallback also shows earlier thread pairs: require the new answer
  // after the new question, not a 42 left over from the first exchange.
  const workingOk = await settled(() => {
    const current = screen()
    const questionAt = current.lastIndexOf('again?')
    return questionAt >= 0 && current.slice(questionAt).includes('42')
  })
  channel.finish()
  assert.ok(await settled(() => btwThreads.get(channel.agentId)?.turns.at(-1)?.phase === 'completed'), `working side question must complete: ${diagnostics()}`)
  const notSteered = channel.steerCalls.length === 0
  assert.ok(workingOk && notSteered, `side question must work while the main turn is running: ${diagnostics()}`)
  console.log('scenario2 Space dismisses; working-channel opens without steering:', closedOk, workingOk, notSteered)

  // ── Scenario 3: Space closes the working-channel overlay too ─────────
  stdin.write(' ')
  const closedWorking = await settled(() => !has('again?'))
  assert.ok(closedWorking, `Space must dismiss the overlay: ${diagnostics()}`)
  console.log('scenario3 Space dismisses overlay:', closedWorking)

  await instance.unmount()
  stdout.term.dispose()
}
// ── Scenario 4: bare /btw notifies usage ───────────────────────────────
{
  const channel = makeChannel()
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const instance = await render(
    <Chat channel={channel as never} questionStore={new QuestionStore()} />,
    { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  assert.ok(await settled(() => viewportLines(stdout.term).join('').trim().length > 0), 'initial screen must render')
  stdin.write('/btw')
  assert.ok(await settled(() => screenHas(stdout.term, '/btw')), 'bare command must reach composer')
  stdin.write('\r')
  const usageNotified = await settled(() => channel.notifyCalls.some(text => text.includes('用法：/btw')))
  assert.ok(usageNotified, `bare command must report usage: ${JSON.stringify(channel.notifyCalls)}`)
  console.log('scenario4 bare /btw notifies usage:', usageNotified)
  await instance.unmount()
  stdout.term.dispose()
}

// ── Scenario 5: wrapper + runner over a fake chunk stream ──────────────
{
  const wrapped = wrapSideQuestion('what?')
  const wrappedOk = wrapped.startsWith('<side-question-context>') && wrapped.includes('what?') && wrapped.includes('No tools are available')
  const chunks: unknown[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'ok ' },
    { type: 'text-delta', index: 0, text: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'ok text' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const deltas: string[] = []
  const fakeStream = async function* () { yield* chunks }
  const ok = await runSideQuestion({ stream: fakeStream as never, options: {}, onText: d => deltas.push(d) })
  const okAnswer = ok.answer === 'ok text' && deltas.join('') === 'ok text'
  const controller = new AbortController()
  controller.abort()
  // A real adapter's stream rejects with an AbortError once the signal fires.
  const abortingStream = async function* () {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  }
  const aborted = await runSideQuestion({
    stream: abortingStream as never,
    options: {},
    signal: controller.signal,
  })
  assert.ok(wrappedOk && okAnswer && aborted.answer === null && aborted.error === undefined, 'auxiliary call contract, streaming and cancellation must hold')
  console.log('scenario5 wrapper + runner (answer/abort):', wrappedOk, okAnswer, aborted.answer === null && aborted.error === undefined)
}

// ── Scenario 6: an unresolved tool call leaves the request, named as running ─
{
  const text = (value: string) => ({ type: 'text' as const, text: value })
  const call = (id: string, args = '{}') => ({ type: 'tool-call' as const, id, name: 'bash', arguments: args })
  const result = (toolCallId: string) => ({ type: 'tool-result' as const, toolCallId, content: [text('ok')] })
  const hasCall = (messages: readonly { content: readonly { type: string }[] }[]) =>
    messages.some(message => message.content.some(block => block.type === 'tool-call'))

  const running = (...ids: string[]) => new Set(ids)
  const midStep = splitUnresolvedToolCalls([
    { role: 'user', content: [text('run it')] },
    { role: 'assistant', content: [text('Running.'), call('call_1', '{"command":"sleep 30"}')] },
  ] as never[], running('call_1'))
  const midAssistant = midStep.messages.find(message => message.role === 'assistant')
  const trimmedOk = midStep.messages.length === 2 && midAssistant?.content.length === 1 &&
    !hasCall(midStep.messages) && midStep.pending.map(block => block.id).join() === 'call_1'
  const note = wrapSideQuestion('what is running?', midStep.pending)
  const noteOk = note.includes('still executing') && note.includes('bash {"command":"sleep 30"}') &&
    !wrapSideQuestion('q').includes('still executing') &&
    wrapSideQuestion('q', [call('call_2', 'x'.repeat(5000))]).length < 2000 &&
    // An astral character straddling the clip budget must not leave a lone surrogate.
    wrapSideQuestion('q', [call('call_3', `${'x'.repeat(399)}😀${'y'.repeat(100)}`)]).isWellFormed() &&
    // Pretty-printed arguments (the native adapter keeps the provider string) fold onto the bullet line.
    wrapSideQuestion('q', [call('call_4', '{\n  "command": "ls",\n  "cwd": "/tmp"\n}')]).includes('- bash { "command": "ls", "cwd": "/tmp" }')

  // Both answer shapes settle a call: a tool-result block (0.1.5) and a tool-role message (0.1.7).
  const settled = [
    { role: 'assistant', content: [call('call_1')] },
    { role: 'user', content: [result('call_1')] },
  ] as never[]
  const settledTool = [
    { role: 'assistant', content: [call('call_1')] },
    { role: 'tool', toolCallId: 'call_1', content: [text('ok')] },
  ] as never[]
  const untouched = [settled, settledTool].every(history => {
    const split = splitUnresolvedToolCalls(history, running())
    return split.messages === history && split.pending.length === 0
  })

  // Parallel calls settle one at a time: keep the answered call, drop the pending one.
  const partial = splitUnresolvedToolCalls([
    { role: 'assistant', content: [call('call_a'), call('call_b')] },
    { role: 'tool', toolCallId: 'call_a', content: [text('ok')] },
  ] as never[], running('call_b'))
  const partialAssistant = partial.messages[0]
  const partialOk = partial.messages.length === 2 && partialAssistant?.content.length === 1 &&
    partialAssistant.content[0].type === 'tool-call' && partialAssistant.content[0].id === 'call_a' &&
    partial.pending.map(block => block.id).join() === 'call_b'

  const emptied = splitUnresolvedToolCalls([{ role: 'assistant', content: [call('call_1')] }] as never[], running()).messages.length === 0
  const reasoned = splitUnresolvedToolCalls([
    { role: 'assistant', content: [{ type: 'reasoning' as const, text: 'thinking' }, call('call_1')] },
  ] as never[], running('call_1'))
  const reasoningKept = reasoned.messages.length === 1 && reasoned.messages[0]?.content.length === 1 &&
    reasoned.messages[0].content[0].type === 'reasoning'

  // A failed scheduler still closes its step (step/end, turn/end error) without results:
  // that orphan leaves the request too, but only the open step's call is running.
  const event = (type: string, data: object = {}) => ({ type, data })
  const assistantEvent = (...ids: string[]) => event('assistant/message', { message: { role: 'assistant', content: ids.map(id => call(id)) } })
  const resultEvent = (callId: string) => event('tool/result', { message: { role: 'tool', toolCallId: callId, content: [], source: { kind: 'tool', callId } } })
  const failedTurn = [event('turn/start'), event('step/start'), assistantEvent('call_old'), event('step/end'), event('turn/end')]
  const openIds = openStepToolCallIds([
    ...failedTurn, event('turn/start'), event('step/start'), assistantEvent('call_a', 'call_new'), resultEvent('call_a'),
  ] as never[])
  const idle = openStepToolCallIds([...failedTurn, event('turn/start'), event('step/start'), assistantEvent('call_x'), event('step/end')] as never[])
  const scanOk = [...openIds].join() === 'call_new' && idle.size === 0 && openStepToolCallIds(failedTurn as never[]).size === 0
  const roles = (messages: readonly { role: string }[]) => messages.map(message => message.role).join()
  const historic = splitUnresolvedToolCalls([
    { role: 'user', content: [text('build')] },
    { role: 'assistant', content: [call('call_old', '{"command":"make old"}')] },
    { role: 'user', content: [text('again')] },
    { role: 'assistant', content: [call('call_new', '{"command":"make new"}')] },
  ] as never[], openIds)
  const historicOk = !hasCall(historic.messages) && historic.pending.map(block => block.id).join() === 'call_new' &&
    !wrapSideQuestion('q', historic.pending).includes('make old') &&
    // Emptied assistants drop like upstream's empty assistant/message, so user turns may abut;
    // pin the shape so a placeholder or merge strategy is a deliberate change.
    roles(historic.messages) === 'user,user' && roles(midStep.messages) === 'user,assistant'
  const settledIdle = splitUnresolvedToolCalls([
    { role: 'user', content: [text('build')] },
    { role: 'assistant', content: [call('call_old')] },
  ] as never[], openStepToolCallIds(failedTurn as never[]))
  const staleOk = historicOk && settledIdle.messages.length === 1 && settledIdle.pending.length === 0 &&
    !wrapSideQuestion('q', settledIdle.pending).includes('still executing')

  assert.ok(trimmedOk, 'an unresolved tool call must leave the request and come back as pending')
  assert.ok(noteOk, 'the wrapper must name pending calls, clip their arguments on a code-point boundary, and stay unchanged without them')
  assert.ok(untouched, 'a settled history must pass through untouched')
  assert.ok(partialOk, 'a partially settled parallel step keeps only the answered call')
  assert.ok(emptied, 'an assistant message left without content is dropped')
  assert.ok(reasoningKept, 'a reasoning-only remainder stays in the request')
  assert.ok(scanOk, 'only unanswered calls of the open step count as running')
  assert.ok(staleOk, "a closed step's orphan leaves the request without being named as running")
  console.log('scenario6 trimmed / running note / settled passthrough / partial parallel / emptied / reasoning kept / open-step scan / stale orphan:', trimmedOk, noteOk, untouched, partialOk, emptied, reasoningKept, scanOk, staleOk)
}

process.exit(0)
