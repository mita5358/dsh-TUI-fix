# 清理记录 / Cleanup record

2026-10-31，交给用户之前把本轮实验留下的东西收掉。只删自己创建、且已确认没有进程引用的路径。

## 已删除

| 路径 | 大小 | 说明 |
| --- | --- | --- |
| `/tmp/dsh-mirror` | 1.5 G | 镜像 CLI + 三个实验 profile（含泰坦会话的三份拷贝） |
| `/tmp/dsh-mirror-c` | 1.3 G | 第二份镜像/克隆实验 |
| `/tmp/dsh-smoke` | 90 M | 用用户自己的 dsh 验证插件的隔离 `DSH_HOME` |
| `/tmp/dsh-plug` | 36 M | 插件安装实验目录 |
| `/tmp/npm-cache` | 37 M | 打包用临时 npm 缓存 |
| `/tmp/prof` | 3.0 M | cpuprofile |
| `/tmp/xdg-runtime*` | 24 K | pnpm 非交互锁需要的一次性 runtime dir |
| `/tmp/boot-*.jsonl`（14 个） | 56 K | 启动相位采样；原件已复制到 `verify/traces/` |
| `/tmp/dsh-final-smoke` | — | 交付件沙箱复验（安装 + 启动），证据已抄进 `EVIDENCE.md` |

共释放约 3.0 GB（`/tmp` 所在分区从 59% 降到 54%）。

tmux：杀掉了自己开的 `mirror-new`、`titan-mirror` 两个会话；杀之前确认里
面跑的是 `/tmp` 下的实验 profile，不是用户的实时会话。


## 第二轮（2026-11-01，滚到摘要行自动展开）

同一套原则：只删自己做、且已确认无引用的临时路径。

| 路径 | 说明 |
| --- | --- |
| `/tmp/pfx` | 重打补丁系列 + 合并补丁的暂存（已复制进 `patch/`） |
| `/tmp/pack-new` | 重打插件 tarball 的暂存（已复制进 `plugin/`） |
| `/tmp/wt-verify` | 干净 `origin/main` 上验证 `git apply` / `git am` + 编译的 worktree |
| `/tmp/tgzcheck` | 插件包解包，只读检查用 |
| `/tmp/seed-shape*.mjs` | 一次性的种子形状脚本（已正式化为 `verify/verify-seed-shape.mjs`） |
| `/tmp/los.log` | 调试插桩的输出文件（插桩已从沙箱安装里移除） |
| `/tmp/gates-*.log`、`/tmp/wt-*.log` | 门禁/编译日志，结论已抄进 `EVIDENCE.md` |

保留：`/home/Administrator/Coding/dsh-sandbox`（隔离沙箱：`HOME`/`DSH_HOME` 都在里面，
供以后复验；tmux 会话 `sandbox` 就是它）。真实 profile `/home/name11k/.dsh` 依旧未写。

## 第三轮（2026-11-01 深夜，修「停在摘要带上不展开」）

| 路径 | 说明 |
| --- | --- |
| `/tmp/pack3`、`/tmp/pack4`、`/tmp/pack-final` | 三轮重打 tgz 的暂存；最终件已进 `plugin/`（sha256 见 `plugin/SHA256SUMS`） |
| `/tmp/patches-final` | 12 补丁系列 + 合并补丁的暂存（已进 `patch/`） |
| `/tmp/wt-final` | 干净 `83fcf892` 上验证 `git am` 12 补丁 + `compile:src` 的 worktree |
| `/tmp/tgz-inspect` | 交付 tgz 解包审计（确认无插桩：`dbgq` / `los*.log` / `LOAD_ON_SIGHT_MS = 5000` 均为 0） |
| `/tmp/frames`、`/tmp/fr2`、`/tmp/fr3`、`/tmp/frF` | 逐帧抓屏（每次翻页 6 帧 × 80 ms），结论已写进 `EVIDENCE.md §7.1` |
| `/tmp/p[0-3].txt`、`/tmp/hint-{before,after}.txt`、`/tmp/af*.txt` | 单次抓屏的中间产物 |
| `/tmp/los6.log` | 沙箱副本里的临时插桩输出（插桩只加在沙箱安装里，交付 tgz 干净） |
| `/tmp/gates-final.log`、`/tmp/wt-build.log`、`/tmp/pack-final.log` | 门禁/编译/打包日志，结论已抄进 `EVIDENCE.md` |

沙箱本身保留：`/home/Administrator/Coding/dsh-sandbox`（`HOME`/`DSH_HOME`/`last-boot.jsonl` 都在里面），
唯一跑过的 tmux 会话是 `sandbox`，此刻已退出。

## 未动（附原因）

| 对象 | 原因 |
| --- | --- |
| `/home/name11k/.dsh`（真实 profile） | 用户明确拒绝在本终端写真实 profile；插件安装命令留给用户自己执行 |
| `/home/name11k/.local/lib/node_modules/@deepseek-ai/dsh` | 用户环境只读，且是正在使用的 dsh 安装 |
| tmux 会话 `atm9sky` / `claude` / `codex` / `dsh` / `dshweb` / `soulmain` | 用户自己的会话 |
| tmux 会话 `devcheck` / `devcheck2` / `titan17` / `tuisandbox` / `dshtui-pr` | 可能是并行代理或用户自己的实验；不属于本轮的确认资产，保留不动 |
| `/tmp/dsh-dev-check`、`/tmp/tui-sandbox`、`/tmp/titan_bench`（440 M） | 同上，属于上述会话的 scratch |
| `/var/crash/_usr_bit_node.1001.crash`（1.2 G） | 无 sudo，删不掉 |
| `dsh web`（pid 1124672） | 正在运行的进程，不杀 |

## 保留的交付

全部在 `/home/Administrator/Coding/dsh-titan-delivery/`：

```
README.md / README.en.md   交付说明（含门禁复测）
EVIDENCE.md                实测证据
LATENCY-REPORT.md          首帧拆解与 2 s 可行性
CLEANUP.md                 本文件
patch/                     补丁 + 应用器
plugin/                    插件包 + 安装/回滚脚本 + sha256
verify/                    校验脚本 + traces/
make-plugin.sh             重新打插件包
```
