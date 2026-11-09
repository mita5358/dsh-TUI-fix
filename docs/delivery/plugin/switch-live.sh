#!/usr/bin/env bash
# 把 live 的 @deepseek-harness-tui/dsh-tui 从旧 build 换成本目录的
# chunked-open tgz。默认只做检查；--install 才落盘。
#
#   bash switch-live.sh                 # 检查 live 与目标包
#   bash switch-live.sh --install       # 先退出 TUI，再运行
#   bash switch-live.sh --install --force  # 不检查运行中的 TUI（不推荐）
#
# 环境变量：
#   DSH_TUI_PROFILE   profile 名，默认 tui
#   DSH_BIN           dsh 可执行文件，默认 dsh
#   DSH_TUI_TGZ       目标 tgz，默认本目录的 chunked-open 包
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
profile=${DSH_TUI_PROFILE:-tui}
dsh_bin=${DSH_BIN:-dsh}
tgz=${DSH_TUI_TGZ:-$here/deepseek-harness-tui-dsh-tui-0.19.0.tgz}
dsh_home=${DSH_HOME:-$HOME/.dsh}
profile_dir="$dsh_home/profiles/$profile"
pkg_json="$profile_dir/package.json"
lock_file="$profile_dir/pnpm-lock.yaml"
tui_pkg="@deepseek-harness-tui/dsh-tui"
mode=check
force=0

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --install) mode=install ;;
    --check) mode=check ;;
    --force) force=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
note() { printf '%-22s %s\n' "$1" "$2"; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
need_cmd node
need_cmd tar
need_cmd sha256sum
need_cmd "$dsh_bin"

[[ -f $tgz ]] || die "missing tgz: $tgz"
[[ -f $pkg_json ]] || die "missing profile manifest: $pkg_json"
[[ -f $lock_file ]] || die "missing lockfile: $lock_file"

target_sha=$(sha256sum "$tgz" | awk '{print $1}')
expected_sha=$(awk 'NR==1{print $1}' "$here/SHA256SUMS" 2>/dev/null || true)
[[ -n $expected_sha && $target_sha == "$expected_sha" ]] || \
  die "tgz sha256 mismatch: got $target_sha, expected ${expected_sha:-?}"

current_spec=$(node -e '
  const p = require(process.argv[1]);
  const d = p.dependencies || {};
  process.stdout.write(d["@deepseek-harness-tui/dsh-tui"] || "");
' "$pkg_json")
installed_dir="$profile_dir/node_modules/$tui_pkg"
installed_ver=$(node -e '
  try { process.stdout.write(require(process.argv[1]).version || ""); } catch {}
' "$installed_dir/package.json" 2>/dev/null || true)
installed_rounds=$(grep -oE 'OPEN_ROUNDS = [0-9]+' \
  "$installed_dir/lib/types/dsh-adapter/backend/history-chunks.js" 2>/dev/null | head -1 || true)
installed_page=$(grep -c 'TOP_PAGE_ROWS' \
  "$installed_dir/lib/types/components/MessageList.js" 2>/dev/null || true)

target_rounds=$(tar -xOf "$tgz" package/lib/types/dsh-adapter/backend/history-chunks.js 2>/dev/null \
  | grep -oE 'OPEN_ROUNDS = [0-9]+' | head -1 || true)
target_page=$(tar -xOf "$tgz" package/lib/types/components/MessageList.js 2>/dev/null \
  | grep -c 'TOP_PAGE_ROWS' || true)

echo "================ chunked-open live switch ================"
note "profile" "$profile"
note "profile dir" "$profile_dir"
note "current dep" "${current_spec:-<missing>}"
note "installed version" "${installed_ver:-<missing>}"
note "installed OPEN_ROUNDS" "${installed_rounds:-<missing>}"
note "installed TOP_PAGE_ROWS" "${installed_page:-0} hit(s)"
note "target tgz" "$tgz"
note "target sha256" "$target_sha"
note "target OPEN_ROUNDS" "${target_rounds:-<missing>}"
note "target TOP_PAGE_ROWS" "${target_page:-0} hit(s)"
echo "=========================================================="

if [[ $mode == check ]]; then
  if [[ ${installed_rounds:-} == "OPEN_ROUNDS = 2" && ${installed_page:-0} -gt 0 ]]; then
    echo "OK: live 已经是带 TOP_PAGE_ROWS 的最新包。"
  else
    echo "DRIFT: live 还是旧包；摘要行会被 RENDERED_ROW_CAP=120 挡住。"
    echo "下一步（先退出 TUI）：bash $0 --install"
  fi
  exit 0
fi

# ---- install ----
running=$(ps -eo pid=,args= | awk '
  $0 ~ /(^|[\/ ])dsh([ ]|$)/ && $0 ~ /(^|[ ])tui([ ]|$)/ {print}
' || true)
if [[ -n $running && $force -eq 0 ]]; then
  echo "检测到正在运行的 dsh tui：" >&2
  echo "$running" >&2
  die "先退出 TUI，再重跑 --install；确认要热替换才加 --force"
fi

backup_root="$HOME/.dsh/backups/tui-chunked"
backup_dir="$backup_root/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp "$pkg_json" "$backup_dir/package.json"
cp "$lock_file" "$backup_dir/pnpm-lock.yaml"
printf '%s\n' "$profile" > "$backup_dir/profile"
printf '%s\n' "$current_spec" > "$backup_dir/previous-spec"
echo "backup: $backup_dir"

# 同一版本 file: 规格下 add 是 no-op，必须先 remove。
if [[ -n $current_spec ]]; then
  echo "+ dsh plugin --profile $profile remove $tui_pkg"
  "$dsh_bin" plugin --profile "$profile" remove "$tui_pkg" || die "remove failed; backup at $backup_dir"
fi

xdg_created=0
if [[ -z ${XDG_RUNTIME_DIR:-} ]]; then
  export XDG_RUNTIME_DIR=$(mktemp -d)
  xdg_created=1
fi
cleanup() { [[ $xdg_created -eq 1 ]] && rm -rf "$XDG_RUNTIME_DIR"; }
trap cleanup EXIT

echo "+ dsh plugin --profile $profile add $tgz"
if ! "$dsh_bin" plugin --profile "$profile" add "$tgz"; then
  echo "install failed. backup at $backup_dir" >&2
  echo "restore: cp '$backup_dir/package.json' '$pkg_json' && cp '$backup_dir/pnpm-lock.yaml' '$lock_file'" >&2
  die "add failed"
fi

new_rounds=$(grep -oE 'OPEN_ROUNDS = [0-9]+' \
  "$installed_dir/lib/types/dsh-adapter/backend/history-chunks.js" 2>/dev/null | head -1 || true)
new_page=$(grep -c 'TOP_PAGE_ROWS' \
  "$installed_dir/lib/types/components/MessageList.js" 2>/dev/null || true)

if [[ ${new_rounds:-} != "OPEN_ROUNDS = 2" || ${new_page:-0} -le 0 ]]; then
  echo "WARNING: 安装后的文件仍不是最新包" >&2
  echo "  OPEN_ROUNDS: ${new_rounds:-<missing>}" >&2
  echo "  TOP_PAGE_ROWS hits: ${new_page:-0}" >&2
  echo "backup: $backup_dir" >&2
  exit 1
fi

echo
echo "OK: live 已换成最新 chunked-open 包。"
echo "现在启动 TUI（例如在 /home/Administrator/Coding 运行）：dsh tui"
echo "回滚：cp '$backup_dir/package.json' '$pkg_json' && cp '$backup_dir/pnpm-lock.yaml' '$lock_file'，再按旧 spec 重装。"
