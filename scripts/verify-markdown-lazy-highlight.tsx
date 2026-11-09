/**
 * Cold Markdown highlighter regression. Run from the repository root:
 *   node --import tsx/esm scripts/verify-markdown-lazy-highlight.tsx
 *   node --import tsx/esm scripts/verify-markdown-lazy-highlight.tsx --syntax
 *
 * Each case runs in a fresh Node process with a real cli-highlight module
 * cache, a synthetic Ink root and headless xterm. A node:module.registerHooks
 * preload observes the cli-highlight specifier and delegates to nextResolve;
 * it does not replace or mock the loader. A later sibling passive effect
 * imports a sentinel module before the no-load assertions. The control case
 * calls the real loader and proves the same barrier observes that request.
 *
 * Children get NODE_ENV=production before importing React, an environment
 * whitelist and a private HOME/DSH/XDG/TMP tree. No user session, account,
 * credential or network is used. Node >=22.19 is required. Windows and other
 * non-Linux platforms have not yet been validated.
 *
 * This focused gate covers ordinary Markdown, folded fence and expansion,
 * plus SyntaxText's four non-highlighting conditions and later eligible text.
 * A separate SyntaxText case keeps an empty visible line with nonempty source
 * eligible. It does not assert mouse routing, nested blocks, streaming long
 * tails, or pending-load unmount races; broader regressions remain necessary.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { ReactNode } from 'react'

const CASES = ['control', 'plain', 'fold', 'syntax-transition', 'syntax-empty'] as const
type Case = typeof CASES[number]
const selectedCases: readonly Case[] = process.argv.includes('--syntax')
  ? ['control', 'syntax-transition', 'syntax-empty']
  : ['control', 'plain', 'fold']
type ResolveObserver = { requests: number; notify?: () => void }
const OBSERVER = '__dshMarkdownHighlightObserver'
const TIMEOUT_MS = 30_000
const CAPTURE_LIMIT = 64 * 1024

// Installed before tsx and the entrypoint in each child. Observation only:
// every request is delegated to Node's real resolver without alteration.
const observerSource = `
import { registerHooks } from 'node:module';
globalThis.${OBSERVER} = { requests: 0 };
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cli-highlight') {
    const state = globalThis.${OBSERVER};
    state.requests += 1;
    state.notify?.();
  }
  return nextResolve(specifier, context);
}});
`
const observerUrl = `data:text/javascript,${encodeURIComponent(observerSource)}`
const sentinelUrl = `data:text/javascript,${encodeURIComponent('export const sentinel = true')}`

/** Return only variables needed to launch Node and the synthetic fixture. */
function childEnvironment(home: string, testCase: Case): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: join(home, 'dsh'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    TMPDIR: join(home, 'tmp'),
    TMP: join(home, 'tmp'),
    TEMP: join(home, 'tmp'),
    NODE_ENV: 'production',
    TSX_DISABLE_CACHE: '1',
    FORCE_COLOR: '3',
    TERM_PROGRAM: 'kitty',
    DSH_TUI_LANG: 'en',
    DSH_TUI_THEME: 'dark',
    DSH_HIGHLIGHT_TEST_CASE: testCase,
  }
  // Windows process launch may need these. Credentials, proxy settings,
  // NODE_OPTIONS, and all existing DSH/XDG state are intentionally absent.
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

async function runParent(): Promise<void> {
  const tempRoot = realpathSync(tmpdir())
  const scratch = realpathSync(mkdtempSync(join(tempRoot, 'dsh-markdown-highlight-')))
  assert.equal(dirname(scratch), tempRoot)
  assert.ok(basename(scratch).startsWith('dsh-markdown-highlight-'))
  let active: ChildProcess | undefined
  let activeClosed: Promise<void> | undefined
  let terminateActive: (() => void) | undefined
  let interrupted = false
  const interrupt = (): void => { interrupted = true; terminateActive?.() }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    const tsxLoader = import.meta.resolve('tsx/esm')
    const entry = fileURLToPath(import.meta.url)
    const failures: string[] = []
    console.log(`Markdown lazy-highlight checks: ${process.platform}, Node ${process.version}, production React; non-Linux platforms not yet validated`)
    for (const testCase of selectedCases) {
      if (interrupted) throw new Error('runner interrupted')
      const home = join(scratch, testCase)
      mkdirSync(join(home, 'tmp'), { recursive: true })
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; timedOut: boolean; truncated: boolean; spawnError: string }>(resolve => {
        const child = spawn(process.execPath, ['--import', observerUrl, '--import', tsxLoader, entry, '--child'], {
          cwd: home,
          env: childEnvironment(home, testCase),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        active = child
        let resolveClosed: (() => void) | undefined
        activeClosed = new Promise<void>(done => { resolveClosed = done })
        let output = ''
        let truncated = false
        let timedOut = false
        let spawnError = ''
        let killTimer: ReturnType<typeof setTimeout> | undefined
        const terminate = (): void => {
          child.kill()
          killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1_000)
        }
        terminateActive = terminate
        const capture = (data: Buffer): void => {
          const text = data.toString()
          const room = Math.max(0, CAPTURE_LIMIT - output.length)
          output += text.slice(0, room)
          if (text.length > room) truncated = true
        }
        child.stdout?.on('data', capture)
        child.stderr?.on('data', capture)
        const timer = setTimeout(() => { timedOut = true; terminate() }, TIMEOUT_MS)
        // Even a spawn error waits for close, so no scratch files are removed
        // until the child and both capture pipes have finished.
        child.once('error', error => { spawnError = error.message })
        child.once('close', (code, signal) => {
          clearTimeout(timer)
          if (killTimer) clearTimeout(killTimer)
          active = undefined
          terminateActive = undefined
          resolveClosed?.()
          resolve({ code, signal, output, timedOut, truncated, spawnError })
        })
      })
      if (outcome.timedOut || outcome.truncated || outcome.spawnError !== '' || outcome.signal !== null || outcome.code !== 0) {
        failures.push(`${testCase}: child failed (exit=${outcome.code}, signal=${outcome.signal}, timeout=${outcome.timedOut}, truncated=${outcome.truncated}, spawnError=${outcome.spawnError})\n${outcome.output}${outcome.truncated ? '\n[child output truncated]' : ''}`)
        console.error(`FAIL ${testCase}`)
      } else {
        console.log(`PASS ${testCase}: ${outcome.output.trim()}`)
      }
    }
    if (failures.length > 0) throw new Error(failures.join('\n'))
  } finally {
    if (active) {
      terminateActive?.()
      await activeClosed
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    // Re-resolve and check the owned absolute path immediately before deletion.
    const actual = realpathSync(scratch)
    assert.equal(actual, scratch, 'refuse cleanup of redirected scratch directory')
    assert.equal(dirname(actual), tempRoot, 'refuse cleanup outside temporary root')
    assert.ok(basename(actual).startsWith('dsh-markdown-highlight-'))
    rmSync(actual, { recursive: true, force: true })
  }
}

async function runChild(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'production', 'React must be loaded in production mode')
  const testCase = process.env.DSH_HIGHLIGHT_TEST_CASE as Case
  assert.ok(CASES.includes(testCase), 'unknown child case')
  const observer = (globalThis as typeof globalThis & { [OBSERVER]?: ResolveObserver })[OBSERVER]
  assert.ok(observer, 'resolve observer preload missing')
  assert.equal(observer.requests, 0, 'highlighter was already requested before the fixture')
  const [React, xterm, ui, markdownModule, syntaxModule, loader, stats] = await Promise.all([
    import('react'), import('@xterm/headless'), import('../src/ui.js'),
    import('../src/components/Markdown.js'), import('../src/components/SyntaxText.js'),
    import('../src/terminal-utils/cliHighlight.js'), import('../src/ink/render-stats.js'),
  ])
  const { createElement: h, useEffect } = React
  const { Markdown } = markdownModule
  const { SyntaxText } = syntaxModule
  const { render, AlternateScreen, Box, Text } = ui
  const terminal = new xterm.Terminal({ cols: 100, rows: 30, scrollback: 0, allowProposedApi: true })
  const fd = openSync(join(process.env.HOME!, 'tty-output'), 'w')
  const pulse = new EventEmitter()
  let frames = 0
  let pendingWrites = 0
  let barrierEffect = false
  let barrierDone = false
  let observedAtBarrier = -1
  let controlLoaded = false
  let controlError: unknown
  observer.notify = () => pulse.emit('change')

  class FakeStdout extends Writable {
    columns = 100
    rows = 30
    isTTY = true
    fd = fd
    override _write(chunk: unknown, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
      pendingWrites++
      terminal.write(String(chunk), () => { pendingWrites--; pulse.emit('change'); done() })
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const stderr = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { isTTY: true })
  const lines = (): string[] => Array.from({ length: 30 }, (_, y) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + y)?.translateToString(true) ?? '')
  const has = (text: string): boolean => lines().some(line => line.includes(text))
  const drain = (): Promise<void> => new Promise((resolve, reject) => stdout.write('', error => error ? reject(error) : resolve()))
  const waitFor = (predicate: () => boolean, label: string): Promise<void> => new Promise((resolve, reject) => {
    const finish = (error?: Error): void => { clearTimeout(timer); pulse.off('change', check); error ? reject(error) : resolve() }
    const check = (): void => { try { if (predicate()) finish() } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) } }
    const timer = setTimeout(() => finish(new Error(`${testCase}: timed out waiting for ${label}`)), TIMEOUT_MS - 2_000)
    pulse.on('change', check)
    check()
  })

  function EffectBarrier(): null {
    useEffect(() => {
      barrierEffect = true
      void import(sentinelUrl).then(() => queueMicrotask(() => {
        observedAtBarrier = observer!.requests
        barrierDone = true
        pulse.emit('change')
      }))
    }, [])
    return null
  }
  function LoaderControl(): null {
    useEffect(() => {
      void loader.getCliHighlightPromise().then(value => {
        controlLoaded = value !== null
        if (value === null) controlError = new Error('real cli-highlight import returned null')
        pulse.emit('change')
      }, error => { controlError = error; pulse.emit('change') })
    }, [])
    return null
  }
  const root = (child: ReactNode): ReactNode => h(AlternateScreen, null,
    h(Box, { width: 100, flexDirection: 'column' }, child, h(EffectBarrier)))
  const code = 'const answer = 42'
  const fenced = `INTRO\n\n\`\`\`js\n${code}\n\`\`\``
  // Keep the same four component positions on rerender: only the first
  // SyntaxText changes from language=undefined to a supported language.
  const syntaxFixture = (eligible: boolean): ReactNode => h(Box, { flexDirection: 'column' },
    h(SyntaxText, { text: code, sourceText: code, language: eligible ? 'js' : undefined }),
    h(SyntaxText, { text: 'EMPTY_SOURCE', sourceText: '', language: 'js' }),
    h(SyntaxText, { text: 'COLOR_OVERRIDE', sourceText: code, language: 'js', color: '#ff0000' }),
    h(SyntaxText, { text: 'DIM_OVERRIDE', sourceText: code, language: 'js', dimColor: true }))
  const emptySyntaxFixture = (): ReactNode => h(Box, { flexDirection: 'column' },
    h(Text, { children: 'BEFORE_EMPTY' }),
    h(SyntaxText, { text: '', sourceText: 'const x = 1\n\nconst y = 2', lineIndex: 1, language: 'js' }),
    h(Text, { children: 'AFTER_EMPTY' }))
  const colorDiffers = (): boolean => {
    const y = lines().findIndex(line => line.includes(code))
    if (y < 0) return false
    const x = lines()[y]!.indexOf(code)
    const row = terminal.buffer.active.getLine(terminal.buffer.active.baseY + y)
    const keyword = row?.getCell(x)
    const number = row?.getCell(x + code.indexOf('42'))
    return keyword !== undefined && number !== undefined &&
      (keyword.getFgColorMode() !== number.getFgColorMode() || keyword.getFgColor() !== number.getFgColor())
  }

  let app: Awaited<ReturnType<typeof render>> | undefined
  try {
    const child = testCase === 'control'
      ? h(Box, { flexDirection: 'column' }, h(LoaderControl), h(Text, { children: 'CONTROL' }))
      : testCase === 'plain'
        ? h(Markdown, { children: '**标签：**中文 👩‍💻 `inline` [link](https://example.com)\n\n| 列 | 值 |\n|---|---|\n| 一 | $x^2$ |' })
        : testCase === 'syntax-transition'
          ? syntaxFixture(false)
          : testCase === 'syntax-empty'
            ? emptySyntaxFixture()
            : h(Markdown, { foldedCode: true, children: fenced })
    app = await render(root(child), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
      onFrame: () => { frames++; pulse.emit('change') },
    })
    await waitFor(() => barrierEffect && barrierDone && frames > 0 && pendingWrites === 0, 'passive effect and sentinel loader barrier')
    await drain()

    if (testCase === 'control') {
      assert.ok(observedAtBarrier > 0, 'positive control was not observed before the sentinel barrier')
      await waitFor(() => controlLoaded || controlError !== undefined, 'real highlighter control')
      assert.ifError(controlError)
      assert.ok(controlLoaded, 'real highlighter did not load')
    } else if (testCase === 'plain') {
      assert.equal(observedAtBarrier, 0, 'ordinary Markdown requested cli-highlight')
      assert.equal(observer.requests, 0)
      assert.ok(has('中文') && has('inline') && has('link'), 'ordinary Markdown did not paint')
    } else if (testCase === 'syntax-transition') {
      assert.equal(observedAtBarrier, 0, 'ineligible SyntaxText requested cli-highlight')
      assert.equal(observer.requests, 0)
      assert.ok(has(code) && has('EMPTY_SOURCE') && has('COLOR_OVERRIDE') && has('DIM_OVERRIDE'), 'all four SyntaxText fixtures must paint')
      assert.ok(!colorDiffers(), 'language-less text should initially use a single fallback color')
      app.rerender(root(syntaxFixture(true)))
      await waitFor(() => observer.requests > 0, 'real loader request after SyntaxText becomes eligible')
      const highlight = await loader.getCliHighlightPromise()
      assert.ok(highlight, 'real cli-highlight failed to load for SyntaxText')
      await waitFor(colorDiffers, 'SyntaxText colors on actual xterm cells')
      await drain()
      assert.equal(observer.requests, 1, 'SyntaxText should share one highlighter resolution')
      assert.ok(has('EMPTY_SOURCE') && has('COLOR_OVERRIDE') && has('DIM_OVERRIDE'), 'other fixtures changed during the transition')
    } else if (testCase === 'syntax-empty') {
      assert.ok(observedAtBarrier > 0, 'empty visible text with nonempty source must still request cli-highlight')
      const highlight = await loader.getCliHighlightPromise()
      assert.ok(highlight, 'real cli-highlight failed to load for empty visible text')
      await drain()
      assert.equal(observer.requests, 1, 'empty-line case should share one highlighter resolution')
      assert.ok(has('BEFORE_EMPTY') && has('AFTER_EMPTY'), 'empty-line fixtures did not paint')
    } else {
      assert.equal(observedAtBarrier, 0, 'folded fence unexpectedly requested cli-highlight')
      assert.equal(observer.requests, 0)
      assert.ok(has('⌁') && has(code), 'folded code summary did not paint')
      // A React prop transition isolates highlighter behavior from mouse input;
      // the separate Chat fence regression covers actual disclosure gestures.
      app.rerender(root(h(Markdown, { foldedCode: true, expandedCodePaths: new Set(['tokens/2']), children: fenced })))
      await waitFor(() => observer.requests > 0, 'real loader request after expansion')
      const highlight = await loader.getCliHighlightPromise()
      assert.ok(highlight, 'real cli-highlight failed to load')
      await waitFor(() => stats.renderWork.codeHighlight > 0 && frames > 0 && pendingWrites === 0, 'code highlight render')
      await drain()
      assert.equal(observer.requests, 1, 'shared highlighter was resolved more than once')
      assert.ok(has(code), 'expanded code body did not paint')
      await waitFor(colorDiffers, 'syntax colors on actual xterm cells')
      assert.ok(colorDiffers(), 'keyword and number were not syntax-colored differently')
    }
    console.log(`real loader requests=${observer.requests}; barrier=${observedAtBarrier}`)
  } finally {
    observer.notify = undefined
    if (app) await app.unmount()
    terminal.dispose()
    closeSync(fd)
  }
}

if (process.argv.includes('--child')) await runChild()
else await runParent()
