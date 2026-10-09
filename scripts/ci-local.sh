#!/usr/bin/env bash
# Run the GitHub Actions CI gate locally, step for step.
#
#   pnpm ci:local            # the `check` job (lint → typecheck → cycles → coverage → unit)
#   pnpm ci:local --e2e      # also the `e2e` job (node · bun · deno · real frameworks), ~5 min
#   pnpm ci:local --force    # ignore the turbo cache, so every package really re-runs
#   pnpm ci:local --no-install
#
# WHY THIS EXISTS: `pnpm test` is NOT what CI runs. The gate runs `turbo run test:coverage`
# (each package enforcing its own thresholds) and `turbo run test:unit` (harness-owned suites that
# define no test:coverage script and are therefore invisible to the other task). A change can pass
# `pnpm test` and still fail the gate.
#
# Kept in lockstep with .github/workflows/ci.yml BY HAND — if you add a step there, add it here.
set -uo pipefail

cd "$(dirname "$0")/.."

RUN_E2E=0
FORCE=""
INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --e2e) RUN_E2E=1 ;;
    --force) FORCE="--force" ;;
    --no-install) INSTALL=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
red() { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow() { printf '\033[33m%s\033[0m\n' "$1"; }

# The runner uses Node 22 (pinned in the workflow). A different major here is a real source of
# divergence — a syntax or API difference can pass locally and fail there, or vice versa.
#
# CI runs on GitHub-hosted macOS (arm64), so the OS and architecture match this machine, which makes
# this script a close stand-in. The Node major is the main thing left to diverge.
CI_NODE_MAJOR=22
LOCAL_NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$LOCAL_NODE_MAJOR" != "$CI_NODE_MAJOR" ]; then
  yellow "! Node v$LOCAL_NODE_MAJOR locally, v$CI_NODE_MAJOR on the runner — results can differ."
fi

FAILED=()
STEP_TIMES=()

step() {
  local name="$1"; shift
  bold "── $name"
  local started
  started=$(date +%s)
  if "$@"; then
    STEP_TIMES+=("$(( $(date +%s) - started ))s  $name")
    green "   ok"
  else
    STEP_TIMES+=("$(( $(date +%s) - started ))s  $name  [FAILED]")
    red "   FAILED: $name"
    FAILED+=("$name")
  fi
}

# `--frozen-lockfile` is part of the gate: it fails when the lockfile is out of sync with a
# package.json, which is otherwise only discovered on the runner.
if [ "$INSTALL" -eq 1 ]; then
  step "Install dependencies (frozen lockfile)" pnpm install --frozen-lockfile
fi

step "Lint (biome)" pnpm lint
step "Typecheck (tsc)" pnpm typecheck
step "Dependency cycles (madge)" pnpm check:cycles
step "Publishable packages" pnpm check:publishable
step "Test + per-package coverage gate (vitest)" pnpm exec turbo run test:coverage $FORCE
step "Harness unit tests (vitest)" pnpm exec turbo run test:unit $FORCE

if [ "$RUN_E2E" -eq 1 ]; then
  # The harness SKIPS a runtime whose binary is absent, so a missing bun/deno would quietly test
  # less rather than fail — same reason the workflow verifies the matrix before running.
  bold "── Verify the runtime matrix is complete"
  MISSING=0
  for bin in node bun deno; do
    if command -v "$bin" >/dev/null 2>&1; then
      printf '   %-5s %s\n' "$bin" "$("$bin" --version 2>&1 | head -1)"
    else
      red "   $bin is NOT installed — the e2e harness would silently skip it"
      MISSING=1
    fi
  done
  if [ "$MISSING" -eq 1 ]; then
    FAILED+=("Runtime matrix incomplete")
  else
    # Playwright ships a downloader, not the browsers. A developer who has run it before already
    # has them cached, which is precisely why their absence on CI went unnoticed — so this mirrors
    # the workflow rather than assuming a warm cache.
    step "Install Playwright's Chromium" pnpm --filter @bugsee/instrumentation-tests exec playwright install chromium

    # Same reason the workflow does this: nuxt/sveltekit/astro bind fixed ports, and a Ctrl-C'd
    # run can leave the dev server holding one. The next run then dies with EADDRINUSE and looks
    # like a broken change rather than leftover state.
    step "Free the harness ports" bash scripts/free-e2e-ports.sh
    step "E2E suites (turbo run test:e2e)" pnpm exec turbo run test:e2e $FORCE
    bash scripts/free-e2e-ports.sh >/dev/null 2>&1 || true
  fi
fi

echo
bold "── Summary"
for t in "${STEP_TIMES[@]}"; do echo "   $t"; done
echo
if [ "${#FAILED[@]}" -eq 0 ]; then
  green "CI gate passed locally."
  if [ -z "$FORCE" ]; then
    echo "   (turbo served some tasks from cache; re-run with --force to execute everything)"
  fi
  if [ "$RUN_E2E" -eq 0 ]; then
    echo "   (the e2e job was NOT run; add --e2e)"
  fi
  # Hosted runners are slower and noisier than a dev machine, so a timing-shaped failure in CI is
  # not necessarily a real race — but assert ratios rather than wall-clock budgets either way.
  yellow "   Note: CI runs on shared GitHub-hosted VMs — never assert wall-clock durations."
  exit 0
fi
red "CI gate FAILED locally:"
for f in "${FAILED[@]}"; do red "   - $f"; done
exit 1
