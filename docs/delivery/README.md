# 长会话分块打开 / Chunked session open

超大会话（十万级事件）恢复时，耗时不只来自 UI 绘制：宿主仍会完整解压、解析并校验日志。本地前端补丁的方向是**只物化需要显示的正文块，同时保留完整、可导航的轻量轮次索引**；旧块每块一行摘要，按需或滚到视口时加载。历史启动耗时不能替代本轮新构建的测量。

> 完整设计和验收边界：[动态历史加载架构](docs/dynamic-history-loading.md)。
> English: [README.en.md](README.en.md)

## 行为

| 位置 | 变化 |
| --- | --- |
| 打开会话 | 只投影最新 `OPEN_ROUNDS=2` 轮 / `OPEN_CHARS=200k` 字符；更早的**每块**历史只落**一行** `⏸ 第 N–M 轮 · X 条事件 · Y 次工具调用 · Z 字 · 滚到这里自动展开`，块内不保留任何占位行 |
| 滚到摘要行 | 视口里离屏幕中心最近的那行摘要停 120 ms 即自动物化它那一块（一次滚动只展一块；跟随底部时不触发），物化后立即重画，摘要行变成 `▾ …` 标题，下面接真实轮次 |
| 顶部 | 还有更早历史时出现 `↑ 加载更早消息（会话日志完整，/export 导出全文）` |
| `ctrl+e` / 点分隔行 | 按块（`CHUNK_ROUNDS=50` 轮 / `CHUNK_CHARS=1M` 字符）向前加载一块 |
| 右侧轮次索引 | 首屏保留全部用户轮次及悬停预览，不依赖正文是否加载；数量超过屏高时沿用原版滑动窗口 |
| 点摘要行 / rail 跳转 | 只物化被点的那一块；点轮次按日志序号精确定位真实提问，不只跳到块头 |
| 折叠恢复 | 恢复走单趟扫描 + 容器单次 dirty，不再逐行扫 |
| 点索引后的时延 | 块内 replay 跳过只用于记账的 token 估算（`AgentEventMeta.scratch`），摘要预览改成有界窗口扫描，跨代 Yoga 缓存槽 4→8，跨渲染窗落点、落点后静默与已载块逐出把「点一次涨一截」的行数固定住。§6.3 记的 372 块重负载是物化 245/502 ms、落地 308/845 ms；同一夹具同口径复测（2026-11-06）为物化 **84/147 ms**、落地 **103/219 ms**（两队列物化 p95 136–147 ms、落地 p95 195–219 ms），20 次点击全部精确落点（无头 xterm 同进程写屏，偏保守；见 [EVIDENCE.md §11](EVIDENCE.md)） |

### 分块正文与完整轮次目录

历史上“每块一行摘要”曾导致右侧只剩最新几轮。本版让每行摘要携带不可见的用户轮次元数据：首屏可列出全部真实用户轮次及预览，但正文仍每个旧块只显示一行摘要。悬停不加载正文；点旧轮时只物化所属块，再按日志 `seq` 跳到块内准确的那条提问。用户新输入、会话清空和同会话重绑也纳入回归。

这不是宿主级随机读取：宿主日志恢复、翻译、分块规划与完整索引仍需处理整份记录；已加载块超出 6 块时按最近使用折回摘要行（滚回即自动重载）。完整约束见 [动态历史加载架构](docs/dynamic-history-loading.md)。

### 滚动自动展开与实测几何（历史第 12 个提交）

最初两版有个读者能直接看到的问题：停在摘要带上那行不展开，得再滚一格才出现内容。
原因两条——候选块是按渲染期的估算行高挑的（真到视口中心时已经偏出上百行），
以及 `revealChunkRow` 物化后没 `emit`（视图要等下一次输入才重画）。现在候选改到
commit 之后按 Yoga 实测中点选，物化成功即 `emit`。复验方式见
[EVIDENCE.md §7.1](EVIDENCE.md)：每翻一页抓 6 帧，摘要带只在前 3 帧（≈240 ms）存在，
随后同一批行号上换成块内原文，期间不再按键。

投影结果与整段投影逐行一致：泰坦会话（93,025 事件 / 93,121 条 / 713 轮 / 102 块）
在 6 个折叠态下都是 28,866 行逐行 `MATCH`。

## 历史实测（前一版分块构建，不代表本轮索引补丁）

| 版本 | 首帧（2026-11-01 历史样本） |
| --- | --- |
| `origin/main`（全量投影） | 16.7–17.3 s |
| 旧分块构建 | **12.3–13.3 s**（样本及运行环境见 `LATENCY-REPORT.md`、`EVIDENCE.md`） |

这些旧数字不能证明本轮全量索引、精确跳转或当前插件包的启动耗时。宿主仍全量回放日志；2 s 目标不是本地 UI 补丁能单独实现的目标，详见架构文档和历史报告。

## 文件

```
patch/dsh-titan-chunked-open.patch   完整 origin/main 补丁（133 文件，+14397/−554；排除 docs/delivery）
patch/0001…0020-*.patch                 20 个 commit 的 git am 系列（与合并补丁等价）
patch/apply.sh                       应用器：默认 git am 整个系列、--single 完整补丁、--check
plugin/install.sh                    把插件包装进某个 dsh profile（默认 dsh-tui）
plugin/uninstall.sh                  换回 registry 版本
plugin/SHA256SUMS                    最终 tgz 的 sha256
plugin/deepseek-harness-tui-dsh-tui-0.19.0.tgz   插件本体（由 make-plugin.sh 重打）
make-plugin.sh                       从已应用全部补丁的检出重新打 tgz
verify/verify-boot-trace.mjs         校验 DSH_TUI_BOOT_TRACE 的相位与耗时
verify/verify-seed-integrity.mjs     校验分块投影与整段投影逐行一致
verify/verify-seed-shape.mjs         校验每块一行摘要与全部用户轮次索引
../dsh-TUI/scripts/verify-chunked-rail.tsx 真实 DSH channel + fullscreen Chat/xterm 集成回归
EVIDENCE.md                          历史输出与本轮索引/跳转/插件验证记录
LATENCY-REPORT.md                    历史性能样本、当前架构边界
CLEANUP.md                           临时目录/进程的清理清单
```

插件包就是 `@deepseek-harness-tui/dsh-tui` 本身重打：分块逻辑活在 TUI 内部，
没有可供第三方薄插件挂钩的接缝，所以"插件"= 换掉 profile 里那个 bundle 的 tgz。
包名不变，版本随基线升到 `0.19.0`（与上游 release 同号），靠 sha256 区分。基线对齐的宿主是 dsh 0.2.2-rc.1；`0.18.0-beta.1` 在 0.2.1-rc.2 上的安装记录见 `EVIDENCE.md`，本轮未重做安装复验。

## 用补丁

```bash
# 只检查（不落盘）
bash patch/apply.sh --check /path/to/dsh-TUI

# 应用全部 20 个 commit（git am；每个都可单独回退）
bash patch/apply.sh /path/to/dsh-TUI

# 或者单文件
git apply --check dsh-titan-chunked-open.patch
```

应用后编译与门禁：

```bash
pnpm --config.verify-deps-before-run=false compile:src
pnpm --config.verify-deps-before-run=false verify:build
pnpm --config.verify-deps-before-run=false typecheck
```

## 用插件（不必改源码）

```bash
# 装进默认 profile（dsh-tui）；先备份 profile 的 package.json / pnpm-lock.yaml
bash plugin/install.sh

# 指定 profile / dsh 可执行文件
DSH_TUI_PROFILE=my-profile DSH_BIN=/path/to/dsh bash plugin/install.sh

# 回滚到上游发布版（默认 0.19.0；profile 原本钉别的版本时显式指定）
DSH_TUI_VERSION=0.19.0 bash plugin/uninstall.sh
```

非交互环境里 pnpm 需要 `XDG_RUNTIME_DIR`：

```bash
XDG_RUNTIME_DIR=$(mktemp -d) bash plugin/install.sh
```

重新打插件包：

```bash
bash make-plugin.sh . /tmp/out   # 需要已应用补丁、已 pnpm install
```

> 换件必须**先 remove 再 add**：`dsh plugin --profile <p> add` 对已装的同一版本是
> no-op（pnpm 认 `file:` 规格），直接 `add` 新 tgz 会「装成功」但文件没换。
>
> ```bash
> dsh plugin --profile manual remove @deepseek-harness-tui/dsh-tui
> dsh plugin --profile manual add plugin/deepseek-harness-tui-dsh-tui-0.19.0.tgz
> ```

## 校验

```bash
# 启动相位（先带 DSH_TUI_BOOT_TRACE=<file> 启一次会话）
node verify/verify-boot-trace.mjs /tmp/boot.jsonl

# 分块投影完整性：需要装着本包的 lib 与一份真实会话日志
DSH_TUI_LIB=<profile>/node_modules/@deepseek-harness-tui/dsh-tui/lib/types \
DSH_SESSION_LOG=<session>/session.v4.jsonl.zstd \
node verify/verify-seed-integrity.mjs
```

## 环境注意

- `pnpm install` 在非 TTY 下需要 `CI=true`，否则拒绝清空 `node_modules`。
- 带 `HTTP(S)_PROXY`（或 `NODE_USE_ENV_PROXY`）时 Node 会打 `UNDICI-EHPA` 警告，
  CLI 测试断言 stderr 为空会因此失败；测试里已用 `NODE_NO_WARNINGS=1` 屏蔽这条
  Node 自带警告。
- tar 7.5.22 的 `exports.import` 指向 ESM 构建，但 `require.resolve` 会落到 CJS 的
  minified 文件；测试改用 `import.meta.resolve` 注入，避免命名导出解析失败。

## 延迟报告

完整的首帧拆解与 2 s 可行性（含宿主侧两条路线）见 [LATENCY-REPORT.md](LATENCY-REPORT.md)。

## 边界

- 正文按需物化，rail 目录涵盖所有真实用户轮次；逻辑索引完整不代表有限终端会同时显示所有 tick。
- 点击未加载轮次只展开其所属块，并在测量收敛后跳到精确真实提问；不可达的尾部轮次受真实 `maxScroll` 约束。
- 宿主仍完整读取/校验日志，索引/翻译也仍随记录长度增长；已加载正文块保留最近 6 块，更早的折回摘要行。
- 未在 Windows / zellij / kitty 图形协议或 inline 模式验证；本轮运行验证集中在隔离 profile 与 tmux 沙箱。

## 门禁复测（2026-11-02，基线 83fcf892）

- `compile:src`、`typecheck` 通过。
- `verify:build` **98/102**（4 个 job）：4 项失败是本机环境既有问题（`verify-backdrop-dim` / `verify-math-inline-image` / `verify-terminal-images-sixel` 在干净 HEAD 上同样失败；`verify:btw` 为既有时序抖动，干净 HEAD 连跑 4 次 3 次失败），`verify:plugin-feed` 本轮也已修（feed 钉到 0.18.0-beta.1），所以是 4 项而不是 5 项。真实 DSH channel + fullscreen Chat/headless xterm 的 `verify:chunked-rail` **42/42** 通过。
- `verify:history-chunks` 与 `verify:timeline-geometry` 通过（几何脚本 49 项）；`verify:timeline-rail`、settle、askpanel repro/layout、toolcards 与滚动锚点（默认及 60 列）通过。
- `verify:package` 通过：`package surface OK (3376 files, 35 entry targets)`。校验器会从 npm `prepare` 日志后的 JSON 报告提取清单，仍完整验证全部包入口。

### 已解决的初次复测波动
- 本轮集成覆盖完整用户轮次与图片预览、仅加载被点块、非首条提问按日志 `seq` 精确落到真实视口、同批次 End 抢占旧 seek、密集真实流式期间历史定位不漂移，以及 clear/new/resume 生命周期。
- 本轮 tgz 与隔离 tmux 沙箱的安装/交互结果见 `EVIDENCE.md` 末尾；未改真实 profile、未操作真实 tmux。

## 本轮复测（基线 v0.19.0 = `4c6131e7`，2026-11-09）

- **补丁落地**：在干净 `4c6131e7` worktree 上 `git am patch/0*.patch`（20 个）通过；
  `bash patch/apply.sh --check` 与 `--single` 也通过。两种方式落地后的工作树与本分支
  tip **逐字节一致**（`git add -A` 后 `git diff` 为空），说明系列与合并补丁等价。
- **typecheck** 通过（`tsc -p tsconfig.typecheck.json`，包版本 `0.19.0`）。
- **逐项 verify（真 exit code）全部通过**：`history-chunks`、`fold-back-user`、
  `chunked-rail`（44 项）、`chat-seek-paging`、`code-fence-lru`、`code-fence-chat`、
  `subagent-group-fold`、`digest-click`、`markdown-lazy-highlight`、
  `syntax-lazy-highlight`、`settled-thinking-summary`、`leading-thinking-lines`、
  `thinking-ticker-tail`、`thinking-virtualization`、`scroll-anchor-overscroll`、
  `rail-window-seek`、`wrap-ansi-incremental`、`top-page-load`、
  `selection-attachment-bounded`、`history-prose-default`、`folded-code-summary`、
  `markdown-filelink-ansi`、`file-target-linear`、`projection-golden`、
  `smooth-reveal`（含上游 #1796 新增的 per-root reveal 分组）。
- `projection-golden`：5 个 golden、83 条 replay 行、41 条 documented live differences。
- **`verify:package` 本轮未跑完**：`npm run compile` 经 `build-vendor` 触发
  `@dsh-tui-vendor/mathjax-tex-svg` 的 `pnpm install`，本机（代理环境）十余分钟未结束。
  上一轮的 `package surface OK (3376 files, 35 entry targets)` 属旧基线，不能引用为本轮结论。
- 首帧与点击时延仍是旧基线的测量（见 `LATENCY-REPORT.md`），本轮没有重跑计时。
