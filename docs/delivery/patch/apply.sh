#!/usr/bin/env bash
# Apply the chunked-open commits to a clean checkout of dsh-TUI.
#
#   bash apply.sh                      # git am the whole series (unstaged commits after am)
#   bash apply.sh --single <repo>      # apply the one-file diff to <repo>
#   bash apply.sh --check <repo>       # only test whether it applies
#
# <repo> defaults to the current git repository.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mode=series
if [[ ${1:-} == --single ]]; then mode=single; shift; elif [[ ${1:-} == --check ]]; then mode=check; shift; fi
repo=${1:-$(git rev-parse --show-toplevel)}

[[ -e $repo/.git ]] || { echo "not a git repository: $repo" >&2; exit 1; }
cd "$repo"

echo "repo: $repo"
echo "HEAD: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
base=4c6131e7
if ! git merge-base --is-ancestor "$base" HEAD; then
  echo "warning: $base is not an ancestor of HEAD; the series was made against it" >&2
fi

case $mode in
  check)
    git apply --check --stat "$here/dsh-titan-chunked-open.patch"
    echo "OK: the combined patch applies to this tree (nothing written)"
    ;;
  single)
    git apply "$here/dsh-titan-chunked-open.patch"
    echo "applied the combined patch (unstaged); build with: pnpm --config.verify-deps-before-run=false compile:src"
    ;;
  series)
    git am "$here"/0*.patch
    echo
    git log --oneline -20
    ;;
esac
