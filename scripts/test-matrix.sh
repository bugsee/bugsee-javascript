#!/usr/bin/env bash
# Cross-Node-version smoke matrix (CI-agnostic — this repo has no in-repo CI).
#
# For each installed Node version it boots the REAL SDK via tsx and asserts the uploaded bundles
# (packages/instrumentation-tests/smoke.ts: the off-thread disk-capture worker path + the incoming-server
# per-request context path — the two surfaces that have had real version-specific bugs). tsx runs on EVERY
# Node version, so this covers Node 18 too, where vitest 4 cannot load at all (rolldown's node:util.styleText).
#
# Usage:
#   scripts/test-matrix.sh                 # smoke on Node 18 20 22 24 (whichever are installed via nvm)
#   scripts/test-matrix.sh 18 20           # smoke on a chosen subset
#   scripts/test-matrix.sh --full 20 22 24 # ALSO run the full unit suite (pnpm test) on each Node >= 20
#
# Complementary gates (run separately): `pnpm test` (full unit suite, host Node) and `pnpm test:e2e`
# (cross-RUNTIME node/bun/deno). This script is the cross-VERSION axis.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm not found at \$NVM_DIR ($NVM_DIR). Install nvm or point NVM_DIR at it." >&2
  exit 1
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

FULL=0
MAJORS=()
for arg in "$@"; do
  if [ "$arg" = "--full" ]; then FULL=1; else MAJORS+=("$arg"); fi
done
[ ${#MAJORS[@]} -eq 0 ] && MAJORS=(18 20 22 24)

TSX="$ROOT/node_modules/.bin/tsx"
SMOKE="$ROOT/packages/instrumentation-tests/smoke.ts"
# A plain string accumulator (no associative arrays — macOS ships bash 3.2, which lacks `declare -A`).
SUMMARY=""
overall=0

for v in "${MAJORS[@]}"; do
  if ! nvm which "$v" >/dev/null 2>&1; then
    echo "[matrix] Node $v not installed (nvm) — skipping"
    SUMMARY="${SUMMARY}$(printf '  Node %-3s  %s\n' "$v" 'SKIP')"
    continue
  fi
  echo "=================== Node $v: scenario smoke ==================="
  if nvm exec "$v" "$TSX" "$SMOKE"; then
    status="smoke:PASS"
  else
    status="smoke:FAIL"
    overall=1
  fi
  # Optional full unit suite where vitest can run (Node >= 20). Node 18 is smoke-only by necessity.
  if [ "$FULL" -eq 1 ] && [ "$v" -ge 20 ]; then
    echo "=================== Node $v: full unit suite (pnpm test) ==================="
    if nvm exec "$v" pnpm test; then
      status="$status full:PASS"
    else
      status="$status full:FAIL"
      overall=1
    fi
  fi
  SUMMARY="${SUMMARY}$(printf '  Node %-3s  %s\n' "$v" "$status")
"
done

echo
echo "===================== Node-version matrix ====================="
printf '%s' "$SUMMARY"
echo "(cross-runtime bun/deno: 'pnpm test:e2e'  |  full unit suite on host Node: 'pnpm test')"
exit "$overall"
