#!/usr/bin/env bash
set -euo pipefail
if command -v gitleaks >/dev/null 2>&1; then exec gitleaks "$@"; fi
root="$(git rev-parse --show-toplevel)"
bin="$root/.orca-scratch/tools/gitleaks"
if [[ ! -x "$bin" ]]; then
  echo 'Install gitleaks on PATH or run scripts/install-gitleaks.sh' >&2
  exit 1
fi
exec "$bin" "$@"
