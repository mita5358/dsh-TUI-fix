# Dynamic history loading: chunked bodies, complete index

[简体中文](dynamic-history-loading.md) · [Architecture](architecture.en.md)

> **Goal confirmed by the user on 2026-11-02:** the original problem was slow loading
> of long conversations. The selected direction is a complete TUI loading architecture
> with **dynamic chunks and a chunk-aware index**, not merely a right-rail fix.
> Future work must not restore whole-history body projection to make navigation work.
> **Implementation and acceptance for this round are complete:** all 102 build gates,
> types/package checks, the 36-case real-channel + Chat integration, seed shape on a
> real 124-chunk session, and isolated-profile installation passed. Evidence and boot
> phases are in delivery `EVIDENCE.md`; historical first-paint numbers are not a new
> performance comparison for this patch.

## 1. Why two layers

A render-row cap is insufficient if startup first projects the entire log and only
then folds/virtualizes it: text processing and tool-result presentation have already
been paid for. Conversely, an unloaded body does not mean that its turns do not exist.

| Previous mistake | Constraint |
| --- | --- |
| Fake `user` placeholder rows made history look like prompts without model replies | One digest row per unloaded chunk; the prompt directory is non-rendered metadata |
| Replacing old user rows with digests left only the newest turns on the rail | Index every real human turn independently of body materialization |
| One rail click triggered whole-history body reprojection | A reveal projects only the owning chunk, never the entire record |
| Estimated heights picked the wrong chunk; seek anchors were released early; a new coordinate beyond the old `maxScroll` was mistaken for tail-follow | Select visible chunks using measured geometry; distinguish explicit seek from follow-bottom and finish only after measurement converges |

```text
Durable session log (unchanged)
  └─ translation and chunk plan
       ├─ lightweight directory: every human turn's identity, prompt reference/preview, image count
       │    └─ rail: complete order, hover previews, reveal handles for unloaded turns
       └─ body chunks: materialize only the newest chunk for first paint
            ├─ older chunk: one notice digest plus non-rendered collapsedTurns metadata
            └─ on demand: replace that digest in place with its heading and real user/model/tool rows
```

A logically complete directory does not draw thousands of ticks simultaneously in a
finite-height terminal; the rail retains its existing viewport window. Once loaded,
real user rows replace their directory entries without duplicate turns. Clear, new
session and session adoption must clear or rebuild the plan, handle mappings and
preview caches rather than resurrect the preceding session's index.

## 2. Boundaries and budgets

The durable backend log remains the source of truth. Projection changes **when**
facts are shown, not the facts: no deletion, lossy log rewriting, invented messages
or re-execution of historical tools. Chunk bodies use the shared projector.

| Item | Current rule |
| --- | --- |
| Newest chunk | `OPEN_ROUNDS = 2`, `OPEN_CHARS = 200_000` |
| Older chunks | `CHUNK_ROUNDS = 50`, `CHUNK_CHARS = 1_000_000` |
| Cuts | Group backward from the newest end; cut only at `user.message` round boundaries, never inside a round |
| Oversized round | Occupies a chunk alone without truncation; these budgets are not hard memory limits |
| Weight | Character lengths of prompt/model text, tool arguments/results, etc., not on-disk byte size |

Chunk rounds include injected/goal and compaction `user.message` events, preventing
long unattended runs from becoming one giant chunk. The **human-turn index** instead
matches the visible user-row predicate: `source === 'user'` and nonempty text or at
least one image. Image-only prompts count; team messages, injected context,
compaction checkpoints and command output must not impersonate human turns.

The default open window is deliberately tiny — the newest two rounds — so first paint
projects only the last exchange and the reader lands on it. Every older turn is still a
tick on the rail / a digest row, and one click projects the chunk that owns it (see §5):
opening less loses nothing; it defers the projection cost to the frame the reader actually
asks for it.

## 3. Identity and exact reveal

A digest's `collapsedTurns` holds `{ id, seq, text, imageCount }`; these entries are
not transcript `ChatRow`s. Their virtual `id` is a navigation handle, not a guessed
projected row offset. Its current namespace lies below every chunk row id:

```text
oldestIdBase = chunk.idBase - chunk.index * ID_STRIDE
handle = oldestIdBase - globalEntryIndex - 1
handle → { chunk, durable seq } → materialize that chunk → real user row id for seq
```

Event and row offsets differ because hidden inputs and tool cards change the row
count. Clicking the second prompt in a chunk must reach that exact prompt, not its
heading or first prompt. Keep old handle aliases until the next seed/clear so a tick
painted before an on-sight load can still resolve the same durable `seq` afterward.

## 4. On-demand loading and navigation geometry

- **Load on sight:** after scrolling, select the digest actually inside the viewport
  nearest its center using post-commit Yoga measurements. An overscan-mounted but
  invisible digest must not trigger loading. The current dwell delay is `120 ms`,
  with at most one automatic expansion per scroll gesture and none while following
  the tail. This delay is not an end-to-end completion deadline.
- **Rail reveal:** an unloaded turn resolves through the mapping above, projects
  only its owning chunk, then force-mounts and seeks the real prompt. Publish the
  materialization immediately; repaint must not depend on another input event.
- **Navigation proxy:** an unloaded turn may borrow its digest's top for relative
  position, never as a substitute for reveal via `scrollTo(proxyTop)`. After a jump
  into old history, another unloaded chunk can be **below** the viewport; `folded`
  cannot always mean “above.” Turns sharing a digest share its proxy top: the last
  one above is ▲ and the first below is ▼. A proxy must not invent a pinned prompt.
  Unreachable real tail prompts remain subject to `maxScroll`.

## 5. Measurement-converged seek handshake (verified)

1. Resolve the real target id and retain `forceMountRowId` to keep it mounted.
2. After row/prefix measurements settle, with no pending measurement correction,
   `MessageList` calls `onSeekReady(rowId, textOffset)`. Derive the offset from that
   prompt's own margin rather than retaining stale geometry.
3. `Chat` aligns against fresh Yoga top plus offset and checks the reachable target,
   `min(targetTop, maxScroll)`. A tail tick that cannot reach the top must not loop
   forever trying to achieve an impossible coordinate.
4. Defer releasing force-mount until the renderer has consumed the seek and the
   scroll position is actually aligned. A ref appearing is not completion, and a
   longer fixed timeout is not a replacement for geometric confirmation.
5. Guard the handshake by request identity and explicit scroll-intent version: a
   new wheel, End or rail jump cancels the old request. Binding generation also
   cancels seeks on same-session rebind. Geometry corrections are not user intent,
   and unrelated streaming below the target must not starve a historical seek.
6. In the explicit element-seek frame, do not restore tail-follow by comparing the
   new coordinate with the **old** `maxScroll`. Expanding a summary is not a user
   returning to the bottom. Further measurement corrections must preserve the
   identity of the requested prompt.

## 6. Cost boundary: no end-to-end constant-time or constant-memory claim

This architecture defers old body projection, tool-result presentation and mounting.
The **host still decompresses, parses and validates the complete log**. Translation,
chunk planning, the directory and session-wide usage accounting still have work
that grows with history, and retain records/references. This is not a host-side
random-access log reader.

Historical measurements on a roughly 93k-event sample recorded first paint dropping
from 16.7–17.3 s to about 12–13 s; larger sandbox snapshots also recorded about 15 s.
These are old measurements from different snapshots/builds, **not proof that this
round's index and seek changes pass**. They do not establish a 2 s startup. Use
`DSH_TUI_BOOT_TRACE` to separate the phases.

**Loaded chunks currently have no LRU eviction.** Browsing more chunks accumulates
real projected rows. Render virtualization bounds mounting, not retention of body
rows, the source log, translated events or directory. Do not describe this as
“end-to-end constant memory”; adding cache or host architectures is outside this
round's scope.

### 6.1 What an index click actually costs, and three fixes

`scripts/perf-rail-click.tsx` replays “click an unloaded turn → its prompt owns the top of
the viewport → still there 200 ms later” against the real DSH channel, the production
fullscreen `Chat` and a headless xterm. The fixture is 372 chunks / 368 human turns (the
heavy shape has ~22 rows and 20 tool calls per chunk) and each sample proves the click really
called `revealRow`, using its return value for identity instead of inferring it from a digest
count that a folding-window repaint can also move.

The click is followed by one synchronous block. It breaks down into three real costs, all
addressed here:

1. **Accounting inside synchronous materialization.** The chunk-scoped projection behind
   `revealRow` estimates tokens for every tool result, which only feeds accounting yet walks
   the whole text. `AgentEventMeta.scratch` lets chunk replay skip those estimates (the
   `countTokens` closure in `projection.ts`); the synchronous part of `revealRow` fell from
   28–61 ms to **2–4 ms**.
2. **Preview slicing.** `preview` used to flatten the whole string before truncating; it now
   scans a bounded doubling window (`transcript.ts`), so digests over large tool results no
   longer pay for their full length.
3. **Layout cache slots.** A reveal mounts a whole chunk of cards in one frame (~1.2k Yoga
   nodes). The cross-generation layout cache in `src/native-ts/yoga-layout` kept only 4 input
   slots per node, but a freshly mounted card probes more than 4 width/mode combinations in a
   single pass, so the LRU wrapped before probes repeated and a 1.6k-node tree was visited
   100k times. At 8 slots `layoutNode` visits fell 102,524 → 29,746 and text measures
   30,847 → 6,254; 16 slots measured no better, so the memory trade stops at 8.

Measured on the equal-bytes fixture (5 clicks × 2 runs, median; click → stable landing):

| Shape | Metric | Before | After |
| --- | --- | --- | --- |
| 1 row / 1 tool call per chunk | landed p50 / p95 | 363 / 592 ms | 329 / 540 ms |
| 22 rows / 20 tool calls per chunk | materialize p50 / p95 | 319 / 612 ms | 245 / 502 ms |
| same | landed p50 / p95 | 367 / 1138 ms | 308 / 845 ms |

Wall-clock includes the headless xterm parsing each frame's output in the same process; a real
terminal paints more cheaply, so these numbers are conservative. The remaining cost is the
first mount of a whole chunk's cards in one frame; progressive mounting would move the landing
geometry, so it is left as follow-up rather than expanded into this round.

### 6.2 By default only "what the user said" and "what the model said" stay expanded

**Problem**: once a chunk is revealed, the whole chunk paints as body text. The rows are carried
by large low-density fields - code fences (a 120-line fence is 120 rows), thinking blocks, tool
cards, multi-line command scripts, long tables. What a reader actually wants is the user prompts
plus the model's prose; everything else in a revealed chunk should default to a one-row digest.

**Change** (`MessageList.tsx`, `Markdown.tsx`, `TranscriptLeaves.tsx`):

- A top-level fenced block inside settled assistant text paints as one digest row:
  `⌁ ts · 26 lines · const marker = … … (click to expand)`. The digest never enters
  `CodeBlockFrame` and is not highlighted or wrap-measured. Clicking the digest expands it and
  clicking the expanded block folds it back (a click is release-without-drag, so drag-selecting
  code still copies); `Ctrl+O` still expands everything.
- Restored rows (`row.restored`: revealed chunks and rows re-prepended by the render cap) fold a
  terminal card header to its first line plus `… +N lines`, the same semantics as the existing
  3-row tool-result cap and 1-row thinking digest.
- Streaming rows (`row.streaming`) never fold: folding only applies to settled content, otherwise
  text would visibly breathe.

**Measurement** (`ASSISTANT_KB=6 RESULT_KB=300 CALLS=3 CMD_LINES=8`, 187 chunks, same-byte fixture,
folding toggled at runtime inside one build, experiment removed afterwards):

| Metric | Unfolded | Folded |
| --- | --- | --- |
| Yoga-measured nodes per frame (3 clicks) | 5854 / 7477 / 7513 | 3830 / 3758 / 3710 |
| Materialize p50 / p95 | 190 / 245 ms | 193 / 372 ms |
| Landed p50 / p95 | 328 / 534 ms | 342 / 604 ms |

Halving the Yoga-measured node count proves the paint cost dropped. Wall-clock click latency in
this fixture is dominated by two things unrelated to folding - chunk projection and the headless
xterm parsing the whole frame - so p50/p95 sits inside ±100 ms noise and must not be quoted as an
end-to-end speedup. The real gain is how many rows a screen actually paints: a 120-line fence
becomes one row.

**Isolation check**: the `dsh-sandbox` manual profile carries this round's tgz; in a `--new`
session the model returned a 38-line python fence and the screen showed only
`● ⌁ python · 38 lines · import random … (click to expand)`; clicking painted the full fence and
clicking the block folded it back. Integration side: `scripts/verify-chunked-rail.tsx` gained six
assertions (digest on screen, body not painted, Ctrl+O round trip, digest click expands, block
click folds back), 36 → 42 all passing.

## 7. Acceptance checklist

As of 2026-11-02, the functional acceptance items below passed. The final long-session
boot trace is recorded in delivery `EVIDENCE.md`. It is not an uncontrolled comparison
against an older build; historical ~12–13 s timings are not proof of this patch's
performance delta.

| Area | This round's evidence |
| --- | --- |
| First paint/performance | Installed-package seed shape: 124 chunks, newest body plus one digest per older chunk; tmux trace records raw-history, seed and render phases without claiming a new comparative speedup; `verify:build` passes 98/102, and `verify-backdrop-dim`, `verify-math-inline-image`, `verify-terminal-images-sixel` fail the same way on a clean HEAD in this environment |
| Index-click latency | `scripts/perf-rail-click.tsx` on the 372-chunk fixture: heavy-shape landed p50/p95 367/1138 ms → 308/845 ms, synchronous reveal 28–61 ms → 2–4 ms (see 6.1) |
| Default folding | Revealed chunks paint a fenced code block as a one-row digest and a terminal card as its first line + `+N lines`; clicking the digest or the block toggles it, `Ctrl+O` still expands all; Yoga-measured nodes roughly halve (see 6.2) |
| Complete index | Real 124-chunk log: 116 older + 3 newest human turns = 119; image/source predicates are covered by chunk tests and materialized turns do not duplicate |
| Exact jump | 36 real-channel + Chat/xterm integration checks cover non-first prompts, owning-chunk-only reveal, stale handles and same-batch End; the sandbox tmux hit a historical tick preview and navigated into old body content |
| Dynamic loading/navigation | 49 rail geometry cases plus all 102 build gates pass, covering proxies, ▲/▼ direction, overscan and digest navigation |
| Seek convergence | Non-first prompt alignment in the real transcript viewport; same-batch End cancellation and dense live-tail stability pass integration assertions |
| Lifecycle | Real append, clear, new, same-shape resume/rebind and preview invalidation are covered by the 36 integration assertions |
| Delivery | compile and typecheck pass; `verify:build` 98/102 (four failures: three pre-existing environment ones plus the existing `verify:btw` flake, all reproduced on clean HEAD; `verify:plugin-feed` was fixed this round and no longer fails); package surface 3376 files / 35 entry targets; the patch (50 files, +3676/−172) passes `git apply --check`, `apply` and `compile:src` on clean baseline `83fcf892`; the rebuilt tarball (`84e4b4b6…`) was reinstalled in the isolated manual profile and exercised with real rail clicks |
| Isolation | Only `/home/Administrator/Coding/dsh-sandbox` HOME/DSH_HOME and `rail-final-20261102` tmux were used; the real profile and `tmux dsh` were not modified |

Implementation: [history-chunks.ts](../src/dsh-adapter/backend/history-chunks.ts),
[extensions.ts](../src/dsh-adapter/channel/extensions.ts),
[MessageList.tsx](../src/components/MessageList.tsx), [Chat.tsx](../src/screens/Chat.tsx),
[timeline-rail.ts](../src/ink/timeline-rail.ts). Historical timings and raw output are
in the delivery directory's `LATENCY-REPORT.md` and `EVIDENCE.md`; old behavior
statements and tarball hashes do not override this round's acceptance contract.
