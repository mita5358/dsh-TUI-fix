#!/usr/bin/env bash
# Install the chunked-open TUI as a dsh profile plugin.
#
#   bash install.sh                     # profile "dsh-tui"
#   DSH_TUI_PROFILE=dsh-tui-2 bash install.sh
#
# What it does: forwards `add <tarball>` to pnpm inside the profile directory,
# which rewrites the profile's package.json dependency for
# @deepseek-harness-tui/dsh-tui to this tarball and installs it. No source
# checkout, no build step, no environment variables.
# Replacing a build at the SAME tarball path/version needs remove BEFORE add;
# pnpm can otherwise keep the previous files while reporting success:
#   dsh plugin --profile <sandbox-profile> remove @deepseek-harness-tui/dsh-tui
# Then run this script with that profile. Back up its manifest/lockfile first.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tgz="$here/deepseek-harness-tui-dsh-tui-0.19.0.tgz"
profile=${DSH_TUI_PROFILE:-dsh-tui}
dsh_bin=${DSH_BIN:-dsh}

[[ -f $tgz ]] || { echo "missing tarball: $tgz" >&2; exit 1; }
command -v "${dsh_bin%% *}" >/dev/null 2>&1 || { echo "dsh not found in PATH; set DSH_BIN=/path/to/dsh" >&2; exit 1; }
read -r -a dsh_cmd <<< "$dsh_bin"

echo "profile: $profile"
echo "Replacing an installed build? Remove the old plugin from this profile first (see script header)."
echo "tarball: $tgz ($(sha256sum "$tgz" | cut -d' ' -f1))"
echo

if ! "${dsh_cmd[@]}" plugin --profile "$profile" add "$tgz"; then
  cat >&2 <<'EOF'

install failed. The two usual causes:

  ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK / "permission denied" on
  /run/user/<uid>/pnpm-store-operation-locks:
      export XDG_RUNTIME_DIR=$(mktemp -d)   # then re-run this script

  pnpm store version mismatch ("installed with a different major version"):
      the profile was installed by another pnpm major. Install manually with
      that same major, from the profile directory:
          cd ~/.dsh/profiles/<profile> && pnpm add <tarball>
EOF
  exit 1
fi

cat <<EOF

installed. The profile now depends on:
  @deepseek-harness-tui/dsh-tui -> $tgz

Restart dsh (or reopen the session) to pick it up. To check what you got:

  node "$here/../verify/verify-boot-trace.mjs" "\$DSH_TUI_BOOT_TRACE"
  # DSH_TUI_BOOT_TRACE=/tmp/boot.jsonl dsh --profile $profile --resume <session-id>

Expected marks on a titan-sized record: raw-history-done, translate-done,
fold-done, newest-done, render-done.

To go back to the published package:

  bash "$here/uninstall.sh"
EOF
