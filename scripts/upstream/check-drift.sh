#!/usr/bin/env bash
# scripts/upstream/check-drift.sh — report origin/main vs upstream/main drift.
#
# Usage:
#   bash scripts/upstream/check-drift.sh           # human-readable
#   bash scripts/upstream/check-drift.sh --json    # JSON for CI consumption
#   bash scripts/upstream/check-drift.sh --quiet   # exit code only
#
# Exit codes:
#   0 — fork is in sync (origin/main contains all of upstream/main)
#   1 — upstream is ahead (one or more upstream commits not yet merged)
#   2 — git/network failure
#
# Upstream remote: https://github.com/farion1231/cc-switch.git

set -euo pipefail

MODE="human"
HEAD_REF="origin/main"
TARGET_REF="upstream/main"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/farion1231/cc-switch.git}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) MODE="json" ;;
    --quiet) MODE="quiet" ;;
    --head | --target)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "$1 requires a commit reference" >&2
        exit 2
      fi
      if [ "$1" = "--head" ]; then HEAD_REF="$2"; else TARGET_REF="$2"; fi
      shift
      ;;
    -h | --help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
  shift
done

log() { [ "$MODE" = "quiet" ] && return; [ "$MODE" = "json" ] && return; echo "$@"; }

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi
if ! git fetch upstream main --quiet 2>/dev/null; then
  echo "ERROR: failed to fetch upstream/main" >&2
  exit 2
fi
if ! git fetch origin main --quiet 2>/dev/null; then
  echo "ERROR: failed to fetch origin/main" >&2
  exit 2
fi

head_sha=$(git rev-parse --verify "${HEAD_REF}^{commit}") || exit 2
target_sha=$(git rev-parse --verify "${TARGET_REF}^{commit}") || exit 2
BEHIND=$(git rev-list --count "$target_sha" --not "$head_sha") || exit 2
AHEAD=$(git rev-list --count "$head_sha" --not "$target_sha") || exit 2
UPSTREAM_HEAD=$(git rev-parse --short "$target_sha")
ORIGIN_HEAD=$(git rev-parse --short "$head_sha")

if [ "$MODE" = "json" ]; then
  printf '{"behind":%d,"ahead":%d,"upstream_head":"%s","origin_head":"%s","in_sync":%s}\n' \
    "$BEHIND" "$AHEAD" "$UPSTREAM_HEAD" "$ORIGIN_HEAD" \
    "$([ "$BEHIND" -eq 0 ] && echo true || echo false)"
elif [ "$MODE" = "human" ]; then
  log "Upstream:  farion1231/cc-switch@$UPSTREAM_HEAD"
  log "Fork:      $HEAD_REF@$ORIGIN_HEAD"
  log "Fork ahead:  $AHEAD commits"
  log "Fork behind: $BEHIND commits"
fi

if [ "$BEHIND" -eq 0 ]; then
  log ""
  log "Fork is in sync with $TARGET_REF."
  exit 0
fi

if [ "$MODE" = "human" ]; then
  log ""
  log "Upstream has $BEHIND new commits not yet merged into the fork:"
  log ""
  git log --oneline -20 "$HEAD_REF..$TARGET_REF" | sed 's/^/  /'
  if [ "$BEHIND" -gt 20 ]; then
    log "  ... ($((BEHIND - 20)) more)"
  fi
  log ""
  log "Next steps:"
  log "  Follow .cursor/skills/cc-switch-upstream-merge/SKILL.md"
  log "  git fetch upstream && git fetch origin"
  log "  git checkout -b merge/upstream-\$(date -u +%Y%m%d) origin/main"
  log "  git merge --no-ff upstream/main"
  log "  bash scripts/preflight.sh"
fi

exit 1
