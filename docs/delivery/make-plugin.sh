#!/usr/bin/env bash
# 从已应用补丁的检出里重新打出分块打开插件包（tgz）。
# Rebuild the chunked-open plugin tarball from a checkout with the patch applied.
#
# 用法 / Usage:
#   bash docs/delivery/make-plugin.sh [repo] [out-dir]
#
# 前置 / Prerequisites: 仓库已 pnpm install；补丁已应用。
set -euo pipefail

repo=${1:-$(git rev-parse --show-toplevel)}
out=${2:-$PWD}
cd "$repo"

[[ -f src/dsh-adapter/backend/history-chunks.ts ]] || {
  echo "补丁未应用：缺少 src/dsh-adapter/backend/history-chunks.ts" >&2
  exit 1
}

# 与 compile:src 同一条链：后端索引 → tsc → settings.json。
node --import tsx/esm scripts/gen-backend-index.mjs
pnpm --config.verify-deps-before-run=false exec tsc -p tsconfig.json
node scripts/gen-settings-json.mjs

# npm pack 必定执行 prepare（prepare-guard + 完整 compile）；打包时临时摘掉。
backup=$(mktemp)
cp package.json "$backup"
restore() { cp "$backup" package.json; rm -f "$backup"; }
trap restore EXIT

node -e '
const fs = require("fs")
const p = JSON.parse(fs.readFileSync("package.json", "utf8"))
delete p.scripts.prepare
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n")
'

# npm 的缓存目录在沙箱/只读 HOME 下可能不可写，显式指到 /tmp。
mkdir -p "$out"
packed=$(npm_config_cache=${npm_config_cache:-/tmp/npm-cache} \
  npm pack --pack-destination "$out" | tail -n1)
tgz="$out/$(basename "$packed")"

# npm 10 在 pnpm 的 isolated 布局下不会把 bundledDependencies 打进 tarball
# （没有 node_modules/.package-lock.json 时 arborist 看不到这棵树），
# 而全新 profile 装完后 @dsh-std/* 必须能从包内解析。这里把已构建的
# vendor 目录补进包内 node_modules，再重新封包。
stage=$(mktemp -d)
trap 'restore; rm -rf "$stage"' EXIT
tar -xzf "$tgz" -C "$stage"
node -e '
const fs = require("fs")
const path = require("path")
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))
for (const name of pkg.bundledDependencies ?? pkg.bundleDependencies ?? []) {
  fs.mkdirSync(path.join(process.argv[1], "package", "node_modules", path.dirname(name)), { recursive: true })
  fs.cpSync(path.join("node_modules", name), path.join(process.argv[1], "package", "node_modules", name), { recursive: true, dereference: true })
}
' "$stage"
tar -C "$stage" -czf "$tgz" package

ls -l "$tgz"
echo "tarball entries: $(tar -tzf "$tgz" | wc -l)"
