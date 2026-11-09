# 泰坦会话首屏延迟 · 分支交付说明

被测会话：`4f91acc4-b674-5ba5-beb3-a012a79f366f`（"泰坦"）——139 MB zstd / 41,985 frame / 93,025 事件 / 713 轮。

> **时间边界**：本报告的启动数字与 `/tmp/boot-post-rebase.jsonl` 来自 2026-11-01 之前的分块打开构建；它们不能证明 2026-11-02 加入的完整用户轮次目录、精确 seek 或本轮重打包的启动耗时。本轮验收状态和架构约束见 `EVIDENCE.md` 末尾及 `docs/dynamic-history-loading.md`。

所有数字在 `/tmp/dsh-mirror`（dsh 0.2.1-rc.3 + 本仓库构建的 dsh-tui 0.17.0）实测，**未动真实 `~/.dsh`、`~/.dsh-tui` 和线上安装**，未 kill 任何线上 dsh。

## 1. 结果

| | 首屏（状态栏出现、可输入） |
|---|---|
| 起点（0.16.1 时代） | 16,669 / 16,872 / 16,995 / 17,145 / 17,258 ms |
| 分块加载落地后 | 14,102 / 14,281 / 14,662 ms |
| 本分支（未推，rebase 到 0.2.1-rc.5 后） | **13,718 / 13,474 / 12,998 ms** |
| 目标 | 2,000 ms —— **未达成，且 TUI 侧到不了**（见 §4） |

同一台机器打开一个 1.8 MB 的普通会话：首帧 4,282 ms。也就是说**空会话的地板就是 ~4.1 s**，泰坦的 13.4 s 里只有 9 s 与会话大小有关。

## 2. 13.4 s 花在哪（`DSH_TUI_BOOT_TRACE` 实测）

| 阶段 | 耗时 | 说明 |
|---|---|---|
| 进程启动 → 插件装载完 | ~4.1 s | node + cordis 插件树 + ~1000 个 ESM 模块（resolve 2.0 s、compile 0.8 s）。小会话同样 4.1 s |
| host 全文恢复 | 7.5 s | 全量读 139 MB → 41,985 frame 解压 → 93k 行 JSON.parse → v4 校验。与字节数线性（约 48 MB/s），不是某个热点函数 |
| TUI seed（本分支） | **1.39 s** | translate 1.04 s（原本 1.84 s）、fold 0.23 s、最新块投影 0.13 s |
| React 首帧 | 0.64 s | 最新块的转录渲染 |

boot trace（rebase 后最新一次 `/tmp/boot-post-rebase.jsonl`）：`raw-history-done=11559, seed-enter=11559, translate-done=12601, fold-done=12831, newest-done=12835, seed-done=12850, render-start=12973, render-done=12998`（rebase 前为 13,120）。

## 3. 本分支做了什么（历史快照：rebase 前的 12 个 commit 哈希，基线 83fcf892，这些哈希已失效；现行 20 个 commit 与基线 `4c6131e7` 见 `README.md` 与 `EVIDENCE.md` §16）

其中 83271418 是文档同步（README 中英两版 + `docs/interaction*.md` 的时间轴点击行为）。

```
20fd85a2 fix(dsh): pick the on-sight chunk by measured rows and repaint it
ef038f45 test(dsh): recount a collapsed chunk's digest and pin the oversized round
8fddf7bb perf(dsh): present a settled result card when its chunk loads
17ae078f perf(dsh): fold the trajectory in slices so the first frame paints
e63efe75 perf(dsh): trace the seed phases so a slow open can be attributed
55449204 fix(dsh): reveal one chunk when the rail jumps to a folded turn
0598df31 feat(dsh): project only the newest history chunk when a session opens
1ecb081e perf(dsh): mark the row container dirty once per restore pass
e1963ff5 perf(dsh): restore folded rows in one pass instead of a scan per row
80aa7be7 fix(dsh): keep a restored row restored across the next fold pass
```

主线是**不再一次性投影全部上下文**，而非只缩短某个函数：按轮切块（最新块 10 轮 / 20 万字，旧块 50 轮 / 100 万字），首屏只投影最新块，旧块在正文每块只留一行摘要。曾经的“每轮一行提示”已撤销，不再制造只有提问、没有回答的假对话。右侧全量轮次目录从摘要附带的轻量元数据生成，独立于正文物化；点某轮只加载所属块，再按持久化 seq 解析真实提问并完成测量收敛后的跳转。工具结果卡片也延迟到块加载时才派生。

2026-11-02 用户再次确认最终目标为“动态分块加载、分块索引”的前端架构。权威设计见源码文档 `docs/dynamic-history-loading.md`（中英同步）。宿主日志仍完整回放，TUI 翻译和轻量索引仍需线性扫记录；这不是端到端常数启动时间，也尚未实现已加载块的 LRU 卸载。

`023f40ad` 修的是你 10 月 30 日那次卡死：pid 11041 点索引栏后 RSS 5.6 GB、CPU 72%，GC 死亡螺旋——原因是点击要物化整块，而索引跳转把「重投影全部行」也触发了；现在一次只物化一块。

## 4. 为什么 2 s 到不了（TUI 侧）

- 12.5 s 是本包能做的地板：剩余全在 **host 全文恢复（7.5 s）** 与 **进程启动（4.1 s）**。
- 已排除的路线（都实测过）：
  - 尾块优先读 → v4 校验不接受"从中间开始的 artifact"（`released v2 row 0 has seq gap`）。
  - restore 进 Worker → `structuredClone` 3,730 ms / 464 MB，净收益 ≈ 0。
  - 投影缓存（`storages/session_projcache`，5.5 KB）→ 只能存状态，不能种出首屏。
  - 日志压缩成 4,512 行 → 打开 5,052 ms 证明成本与行数/字节成正比，但**永久丢数据，否决**。
  - ESM 编译缓存（`NODE_COMPILE_CACHE`）→ 对 ESM 无效。
- 真到 2 s 只有一条路：**常驻 host 进程**（重开 ≈0.5 s，改动在 `dsh-app-boot` / session 装配层，不在这个包）：TUI 连上一个活着的 host，恢复只做校验不再重放。这是产品级架构改动，需要你和上游拍板。

## 4.5 顺手做的事（都在这条分支里）

- `DSH_TUI_BOOT_TRACE=<file>` 记十个阶段点，下次"慢"能直接定位到阶段，不必再猜。
- `scripts/verify-history-chunks.ts`（`verify:build` 顶层门禁，0.5 s）：把分块契约钉死——块平铺覆盖、边界落在轮起点、预算（超重轮不切）、摘要计数独立复算、每块恰好一条 `collapsed` 摘要行（`id == idBase`、可反查回块）、块内不出现伪造的 `user` 行、摘要行 id 不得与活行 id 冲突、物化后的投影含真实的 `assistant`/`user` 行且重编号不越界。
- `scripts/verify-trace-projection.mjs`：轨迹增量折叠的等价性 oracle。

## 5. 复现（两种，插件版不用源码）

### 5.1 插件（推荐）

补丁已经打成一个 profile 插件包（dsh 的 TUI 本身就是 profile 里的 bundle，
所以只换一个依赖，不碰源码）：

```bash
bash /home/Administrator/Coding/dsh-titan-delivery/plugin/install.sh
# 等价于：dsh plugin --profile dsh-tui add .../deepseek-harness-tui-dsh-tui-0.17.0-chunked-open.tgz
# 回滚：bash .../plugin/uninstall.sh
```

空 profile 从零装实测 5.5 s、退出码 0；全新 profile 直接 resume 泰坦：
首帧 **13,159 ms**，`⏸ 第 1–14 轮 · 92 条事件 · 0 次工具调用 · 51k 字 · 滚到这里自动展开` 摘要行、
`↑ 加载更早消息`、rail 点击只展开一块（RSS +6–8 MB）全部正常。沙箱复验（插件版、泰坦 169.9 MB 快照）：
滚动落到摘要行后 120 ms 内该块被物化（行数 163 → 346，`collapsed` 摘要行 123 → 122），
屏幕上直接出现块内真实轮次而不是提示占位。

### 5.2 补丁 + 源码部署

```bash
bash /home/Administrator/Coding/dsh-TUI/docs/delivery/patch/apply.sh   # 20 个 commit（git am 系列）
pnpm --config.verify-deps-before-run=false compile:src
rsync -a --delete /home/Administrator/Coding/dsh-TUI/lib/types/ \
  /tmp/dsh-mirror/dsh-home/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/
echo '{"version":1,"owners":[]}' > /tmp/dsh-mirror/home/.dsh-tui/session-mounts.json
tmux new-session -d -s mt -x 200 -y 50 "cd /home/Administrator/Coding; \
  HOME=/tmp/dsh-mirror/home DSH_HOME=/tmp/dsh-mirror/dsh-home \
  DSH_TUI_WORKSPACE_TARGET=/home/Administrator/Coding NODE_ENV=production \
  DSH_TUI_BOOT_TRACE=/tmp/boot-N.jsonl NODE_OPTIONS=--max-old-space-size=32768 \
  node /tmp/dsh-mirror/dsh-cli/lib/bin.js --profile dsh-tui --resume 4f91acc4-b674-5ba5-beb3-a012a79f366f"
```

### 5.3 验证

```bash
node /home/Administrator/Coding/dsh-titan-delivery/verify/verify-boot-trace.mjs /tmp/boot-N.jsonl
DSH_TUI_LIB=<profile>/node_modules/@deepseek-harness-tui/dsh-tui/lib/types \
  node /home/Administrator/Coding/dsh-titan-delivery/verify/verify-seed-integrity.mjs
```

交付目录：`/home/Administrator/Coding/dsh-titan-delivery/`（`README.md` 是完整说明，
`EVIDENCE.md` 是原始输出，`patch/` + `plugin/` + `verify/` 三类文件）。

## 6. seed 完整性（目标里的"校验上下文不变"）

真实泰坦记录上做了离线等价性 oracle：93,025 事件 → 翻译 93,121 条 → 规划 102 块；
把整条记录一次性投影（28,866 行，1.86 s）与按块投影再拼接（28,866 行，1.77 s）逐行比较
可见字段（kind/text/tool 名与参数与结果/anchor/reasoning/folded）——**两侧完全一致**，
`thinkingFold` 取 `auto` 与 `full` 都通过。结论：分块只改变"何时投影"，不改变投影结果。

## 7. 历史门禁快照（2026-11-01前，101项）

`pnpm verify:build` → **101/101 通过**（31.0 s）。早先的 97/101 是环境问题（tar 的 ESM 命名导出、`TMUX`/代理变量导致 chalk 降级），已在测试与跑法里修掉。
在 `origin/main`（83fcf892，未含本分支）的干净 worktree 上用同一份 `node_modules` 复跑：`cli.test.mjs` 2 个 FAIL、backdrop-dim 8 个 FAIL、math-inline-image exit 7，同样失败 ⇒ **与本分支无关**（本机 `node_modules` 与 lockfile 漂移 + 无 truecolor/sixel 环境）。
`pnpm compile` 需要绕开 pnpm 的 deps-status 检查：`pnpm --config.verify-deps-before-run=false compile`（否则 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。

## 8. 历史交付注记（非本轮待办）

本节保留自早期交付草稿，不构成本轮操作请求。当前用户明确要求不纠结推送，且本轮只将重打 tgz 安装到隔离的 `dsh-sandbox` manual profile；真实 profile 未改动。2 s 启动目标仍需宿主侧方案，超出本地 TUI 动态分块与索引补丁范围。当前 build/package、插件哈希和沙箱验收结果以 `EVIDENCE.md` 末尾为准。

## 9. 2 s 的可行路线（代码级结论）

结论：**2 s 在宿主 + 启动两处同时改造后才可能出现，单改本包无解**。依据是 boot trace 的相位拆分：

| 相位 | 现状 | 2 s 需要的量级 | 归属 |
|---|---|---|---|
| node 进程 + ~1000 个 ESM 模块装载 | 4.1 s | ≤0.5 s | 启动面（可用 node snapshot / 单文件 bundle） |
| 宿主回放原始日志（解压 + 93k 次 JSON.parse + v4 校验） | 7.5 s | ≤0.8 s | 宿主（常驻进程或二进制检查点） |
| TUI seed（translate + fold + 最新块投影） | 1.4 s | 1.4 s（已是本分支成果） | 本包 |
| React 首帧 | 0.6 s | 0.6 s | 本包 |

可行的两条宿主路线，按改动面从小到大：

1. **回放检查点（不动架构）**：v4 校验的产物是「按 seq 排序的已校验事件流」。把 `(sessionId, logSize, logMtime, 最后 seq)` 连同已解码事件序列化（msgpack/二进制）落到 `storages/`，命中时跳过解压与 JSON.parse，只校验头尾与长度。按 48 MB/s 的实测吞吐，139 MB 的解码可降到 0.5–1 s 量级；剩余成本是一次反序列化。
2. **常驻宿主（改动在 `dsh-app-boot` / session 装配层）**：workspace 级常驻进程持有已恢复的会话，TUI 重开只走 IPC 拉最新块，恢复 ≈0.3 s。这条路同时消掉 7.5 s 和大部分 4.1 s，但要把 TUI 从「进程内组合宿主」改成「连接式」，是产品级改动。

两条都需要：`v4` artifact 校验接受"检查点 + 尾部增量"（现在是全量逐行校验，尾块切读会报 `released v2 row 0 has seq gap`，已实测）。

本包能单独贡献的部分：启动面的单文件 bundle / `node --build-snapshot`。按 4.1 s 里 resolve 2.0 s、compile 0.8 s 的占比，乐观能省 2–2.8 s，把首帧从 13.0 s 压到 10–11 s——但仍到不了 2 s，所以没有放进这条分支（避免把交付面撑大）。

因此：**2 s 是宿主侧目标**；这个交付包的定位是「在不动宿主的前提下，把 TUI 侧从 5.4 s 压到 2.0 s，并把首帧从 17 s 拉进 12–13 s」。
