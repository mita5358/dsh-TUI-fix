#!/usr/bin/env bash
# Put the published TUI package back into a dsh profile (undo install.sh).
#
#   bash uninstall.sh
#   DSH_TUI_PROFILE=dsh-tui-2 bash uninstall.sh
set -euo pipefail

profile=${DSH_TUI_PROFILE:-dsh-tui}
dsh_bin=${DSH_BIN:-dsh}
version=${DSH_TUI_VERSION:-0.19.0}

command -v "${dsh_bin%% *}" >/dev/null 2>&1 || { echo "dsh not found in PATH; set DSH_BIN=/path/to/dsh" >&2; exit 1; }
read -r -a dsh_cmd <<< "$dsh_bin"

"${dsh_cmd[@]}" plugin --profile "$profile" add "@deepseek-harness-tui/dsh-tui@$version"
echo
echo "profile $profile now depends on @deepseek-harness-tui/dsh-tui@$version (restart dsh)"
