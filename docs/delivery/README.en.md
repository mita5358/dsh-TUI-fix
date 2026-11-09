# Chunked session open

Large-session loading is not only a paint problem: the host still fully decodes,
parses and validates the log. This local frontend patch **materializes body chunks
on demand while keeping a complete, lightweight turn index**. Older bodies start
as one digest per chunk. Historical startup figures are not measurements of this
current index patch.

> Architecture and acceptance contract: [Dynamic history loading](docs/dynamic-history-loading.en.md).
> 中文版：[README.md](README.md)

## Behavior

| Where | Change |
| --- | --- |
| Open a session | Only the newest `OPEN_ROUNDS=2` rounds / `OPEN_CHARS=200k` characters are projected; every older **chunk** becomes exactly **one** `⏸ rounds N–M · X events · Y tool calls · Z chars · scroll here to expand` row — no placeholder rows inside the chunk |
| Scroll onto a digest row | The digest row nearest the viewport centre that stays put for 120 ms materialises its chunk (one chunk per scroll gesture, never while following the tail); the row turns into a `▾ …` heading followed by the real turns, and the view repaints on that same tick |
| Top of history | `↑ load earlier messages` divider while older history exists |
| `ctrl+e` / click the divider | Load one older chunk (`CHUNK_ROUNDS=50` rounds / `CHUNK_CHARS=1M` characters) |
| Turn rail | Includes every human turn and hover preview from the first frame, independently of body loading; uses the original sliding tick window when turns outnumber screen rows |
| Click a digest row / rail jump | Materialize only the owning chunk; a turn click resolves its durable sequence number and seeks that exact prompt, not just the chunk heading |
| Fold restore | Single-pass scan plus one container dirty mark instead of per-row scans |
| Latency after a rail click | The per-chunk replay skips token estimation used only for accounting (`AgentEventMeta.scratch`), the digest preview scans a bounded window, the cross-generation Yoga cache grows 4→8, and cross-window seeking, post-seek quiet and loaded-chunk eviction keep the row count from growing on every click. The 372-chunk load recorded in §6.3 was materialize 245/502 ms and landed 308/845 ms; the same fixture and definitions re-run on 2026-11-06 gave materialize **84/147 ms** and landed **103/219 ms** (across both cohorts materialize p95 136–147 ms, landed p95 195–219 ms), with all 20 clicks landing exactly (wall clock includes in-process headless-xterm writes, so real terminals are faster; see [EVIDENCE.md §11](EVIDENCE.md)) |

### Chunk bodies and complete turn directory

Earlier, one digest per old chunk left only recent turns on the right rail. Each
digest now carries non-rendered metadata for every human turn in its chunk. The
first screen can show every real prompt and hover preview while older bodies still
render as one digest per chunk. Hovering never loads a body. Clicking an unloaded
turn materializes only its owning chunk, resolves its durable log sequence to the
real prompt row, and seeks after measured layout settles. Live input, clear, and
same-session rebind are covered by regression checks.

This is not host-side random access: host restore, translation, chunk planning and
the complete index still process the full log. Already-loaded chunks do not yet
keep only the six most recently read chunks resident; older ones fold back to their digest row and reload on sight. See the [architecture contract](docs/dynamic-history-loading.en.md).

### Scroll-to-expand fix (historical 12th commit)

The first two cuts had a bug you could see directly: stopping on a digest line did
nothing; the chunk only appeared after one more wheel notch. Two causes — the
candidate chunk was picked from render-time row-height estimates (so by the time a
burst of scrolling settled it was a hundred rows off), and `revealChunkRow` spliced
`state.rows` without an `emit` (the view waited for the next input). The candidate is
now measured after commit from Yoga midpoints, and a successful materialisation emits.
Repro: [EVIDENCE.md §7.1](EVIDENCE.md) — six frames per page show the digest band for
three frames (≈240 ms) and then the real turns in the same line range, with no further
keys.

The projection is row-for-row identical to a whole-history projection: on the
reference session (93,025 events / 93,121 entries / 713 turns / 102 chunks) all
six fold states produce 28,866 rows that `MATCH` line by line.

## Historical measurements (previous chunked build, not this index patch)

| Build | First frame (2026-11-01 historical sample) |
| --- | --- |
| `origin/main` (whole-history projection) | 16.7–17.3 s |
| Previous chunked build | **12.3–13.3 s** (see `LATENCY-REPORT.md` and `EVIDENCE.md` for environment and samples) |

Those figures do not prove startup performance for the current full index, exact
seek behavior, or rebuilt package. The host still replays the full log; a 2 s goal
cannot be achieved by this local UI patch alone.

## Contents

```
patch/0001…0020-*.patch            the git am series: 20 commits, equivalent to the combined patch
patch/dsh-titan-chunked-open.patch   complete clean-base patch (133 files, +14397/−554; excludes docs/delivery)
patch/apply.sh                       applier: git am the series, --single complete patch, --check
plugin/install.sh                    install the rebuilt tarball into a dsh profile (default dsh-tui)
plugin/uninstall.sh                  restore the registry version
plugin/SHA256SUMS                    sha256 for the rebuilt tarball
plugin/deepseek-harness-tui-dsh-tui-0.19.0.tgz   the rebuilt plugin
make-plugin.sh                       rebuild the tarball from a fully patched checkout
verify/verify-boot-trace.mjs         check DSH_TUI_BOOT_TRACE phases and timings
verify/verify-seed-integrity.mjs     compare chunked and whole projection row by row
verify/verify-seed-shape.mjs         check one digest per old chunk and complete turn metadata
../dsh-TUI/scripts/verify-chunked-rail.tsx      real DSH channel + fullscreen Chat/xterm integration regression
docs/dynamic-history-loading.en.md   architecture and acceptance contract
EVIDENCE.md                          historical output plus current index/package/sandbox evidence
LATENCY-REPORT.md                    historical performance samples and current architecture limits
CLEANUP.md                           cleanup list for temp dirs/processes
```

The "plugin" is `@deepseek-harness-tui/dsh-tui` itself, repacked: the chunking
lives inside the TUI, and there is no seam a small third-party plugin could hook.
Installing therefore means swapping the bundle tarball in a profile. Name and
version follows the baseline to `0.19.0` (same number as the upstream release), and the
sha256 is what distinguishes the build.

## Using the patch

```bash
bash patch/apply.sh --check /path/to/dsh-TUI   # check only
bash patch/apply.sh /path/to/dsh-TUI           # all 20 commits (git am)
git apply --check dsh-titan-chunked-open.patch # or the single file
```

Then:

```bash
pnpm --config.verify-deps-before-run=false compile:src
pnpm --config.verify-deps-before-run=false verify:build
pnpm --config.verify-deps-before-run=false typecheck
```

## Using the plugin

```bash
# default profile: dsh-tui; back up the profile's package.json / pnpm-lock.yaml first
bash plugin/install.sh

# explicit profile or dsh binary
DSH_TUI_PROFILE=my-profile DSH_BIN=/path/to/dsh bash plugin/install.sh

# roll back to the published release (default 0.19.0; pass the version
# explicitly when the profile was pinned to something else)
DSH_TUI_VERSION=0.19.0 bash plugin/uninstall.sh
```

pnpm needs a runtime dir when not attached to a terminal:

```bash
XDG_RUNTIME_DIR=$(mktemp -d) bash plugin/install.sh
```

Rebuild the tarball:

```bash
bash make-plugin.sh . /tmp/out   # patched checkout, pnpm install done
```

> Swapping builds needs **remove before add**: `dsh plugin --profile <p> add` is a
> no-op for an already-installed version (pnpm keys on the `file:` spec), so adding a
> new tarball reports success but leaves the old files in place.
>
> ```bash
> dsh plugin --profile manual remove @deepseek-harness-tui/dsh-tui
> dsh plugin --profile manual add plugin/deepseek-harness-tui-dsh-tui-0.19.0.tgz
> ```

## Verification

```bash
node verify/verify-boot-trace.mjs /tmp/boot.jsonl

DSH_TUI_LIB=<profile>/node_modules/@deepseek-harness-tui/dsh-tui/lib/types \
DSH_SESSION_LOG=<session>/session.v4.jsonl.zstd \
node verify/verify-seed-integrity.mjs
```

## Environment notes

- `pnpm install` refuses to purge `node_modules` without a TTY unless `CI=true`.
- With `HTTP(S)_PROXY` / `NODE_USE_ENV_PROXY` set, Node prints an `UNDICI-EHPA`
  warning to stderr; CLI tests asserting empty stderr used to fail on it, so they
  now set `NODE_NO_WARNINGS=1`.
- The gates that compare rendered colours (`verify:backdrop-dim` and the math /
  sixel image gates) expect truecolor; inside tmux the renderer deliberately
  clamps chalk to 256 colours, so run them with `TMUX` unset.
- tar 7.5.22's `exports.import` points at its ESM build while `require.resolve`
  lands on the minified CJS file; the tests inject `import.meta.resolve` instead.

## Limits

- The turn rail covers every real human prompt; a finite terminal still shows only its viewport window.
- Clicking an unloaded turn materializes only its chunk, then seeks the exact real prompt after layout settles; unreachable tail prompts obey the real `maxScroll`.
- Host restore, translation and index planning still process the full record. Only the six most recently read body chunks stay projected.
- Windows, zellij, kitty graphics protocols, and inline mode were not covered; this round verifies the isolated profile and tmux sandbox.

## Previous gate record (2026-11-01)

```bash
env -u TMUX -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
  pnpm --config.verify-deps-before-run=false verify:build
```

- `verify:build` **101/101**; `typecheck` passes; `verify:package` passes (3373 files / 35 entry targets).
- `verify:cli` 34/34. Two **test-only** fixes were needed:
  1. `cli/test/package.test.mjs` now injects tar via `import.meta.resolve('tar')` — tar 7.5.22's
     `require.resolve` lands on the minified CJS build, where named exports cannot be detected.
  2. `cli.test.mjs` / `edges.test.mjs` spawn children with `NODE_NO_WARNINGS=1` — with a proxy
     configured Node itself prints an `UNDICI-EHPA` warning, and those cases assert empty stderr.
- Under `TMUX`, `verify:backdrop-dim` and the two image gates fail: the renderer deliberately clamps
  chalk to 256 colours inside tmux (`src/ink/colorize.ts`) while those cases assert truecolour
  values. Not a regression — they pass with `TMUX` unset.
- `verify:package` run directly is polluted by npm 10.9.8 printing `prepare` output before the
  `--json` payload; filtering everything before the first `[` yields `package surface OK (3373 files,
  35 entry targets)`. npm behaviour, unrelated to this patch.

## Verification (2026-11-02, base 83fcf892)

- `compile:src` and `typecheck` pass.
- `verify:build`: **98/102** with 4 jobs. Four failures are pre-existing on this machine (`verify:backdrop-dim`, `verify:math-inline-image`, `verify:terminal-images-sixel` fail on clean HEAD `20fd85a2`; `verify:btw` is an existing timing flake — 3 of 4 clean-HEAD runs fail the same assertion). `verify:plugin-feed` was also fixed this round by pinning the feed to `0.18.0-beta.1`, so the count is four rather than five. Real DSH channel + fullscreen Chat/headless xterm `verify:chunked-rail`: **42/42**.
- `verify:history-chunks`, 49 `verify:timeline-geometry` cases, timeline rail and settle, askpanel repro/layout, toolcards, and scroll-anchor regressions pass at default and 60-column widths.
- `verify:package` passes: `package surface OK (3376 files, 35 entry targets)`. Its verifier extracts npm's structured report after `prepare` lifecycle output and still checks every package entry.
- Integration covers all human turns and image previews, owning-chunk-only reveal, exact non-first prompt seek, same-batch End superseding a pending seek, historical anchoring during dense real streaming, and clear/new/resume lifecycle.
- Rebuilt tarball and isolated tmux sandbox install/runtime evidence are appended to `EVIDENCE.md`. No real profile or user tmux session was modified.

## Verification this round (base v0.19.0 = `4c6131e7`, 2026-11-09)

- **Patch application**: on a clean `4c6131e7` worktree both paths pass — `git am patch/0*.patch`
  (20 patches) and `bash patch/apply.sh --check` / `--single`. After `git add -A` the resulting
  tree is **byte-identical** to this branch tip, so the series and the combined patch agree.
- **typecheck** passes (`tsc -p tsconfig.typecheck.json`; package version `0.19.0`).
- **Every verify run below passes with its real exit code**: `history-chunks`, `fold-back-user`,
  `chunked-rail` (44 cases), `chat-seek-paging`, `code-fence-lru`, `code-fence-chat`,
  `subagent-group-fold`, `digest-click`, `markdown-lazy-highlight`, `syntax-lazy-highlight`,
  `settled-thinking-summary`, `leading-thinking-lines`, `thinking-ticker-tail`,
  `thinking-virtualization`, `scroll-anchor-overscroll`, `rail-window-seek`,
  `wrap-ansi-incremental`, `top-page-load`, `selection-attachment-bounded`,
  `history-prose-default`, `folded-code-summary`, `markdown-filelink-ansi`,
  `file-target-linear`, `projection-golden`, and `smooth-reveal` (including the per-root reveal
  groups added by upstream #1796).
- `projection-golden`: 5 goldens, 83 replay rows, 41 documented live differences.
- **`verify:package` did not finish this round**: `npm run compile` goes through `build-vendor`,
  which runs `pnpm install` for `@dsh-tui-vendor/mathjax-tex-svg` and had not completed after
  ten-plus minutes on this machine (proxied network). The earlier `package surface OK (3376 files,
  35 entry targets)` belongs to the previous baseline and is not valid evidence here.
- First-frame and click latency numbers are still the old baseline measurements
  (`LATENCY-REPORT.md`); no timings were re-run this round.
