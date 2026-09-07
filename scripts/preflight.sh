#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
area="${1:-all}"
case "$area" in
  all|frontend|backend) ;;
  *) printf 'Usage: bash scripts/preflight.sh [all|frontend|backend]\n' >&2; exit 2 ;;
esac

failed=0
check() {
  local label="$1"
  shift
  if "$@"; then
    printf 'PASS: %s\n' "$label"
  else
    printf 'FAIL: %s\n' "$label" >&2
    failed=1
  fi
}

check whitespace git diff --check
if [[ "$area" == all || "$area" == frontend ]]; then
  check typecheck pnpm typecheck
  check formatting pnpm format:check
  check renderer-build pnpm build:renderer
  check unit-tests pnpm test:unit
  check cursor-session-ssot node scripts/check-cursor-session-ssot.mjs
  check session-chrome-ssot node scripts/check-session-chrome-ssot.mjs
  check session-live-ssot node scripts/check-session-live-ssot.mjs
  check browser-acceptance pnpm test:e2e
fi
if [[ "$area" == all || "$area" == backend ]]; then
  check rust-format cargo fmt --check --manifest-path src-tauri/Cargo.toml
  check clippy cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
  check rust-tests cargo test --manifest-path src-tauri/Cargo.toml
fi
exit "$failed"
