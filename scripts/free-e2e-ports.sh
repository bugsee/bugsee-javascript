#!/usr/bin/env bash
# Free the fixed ports the framework e2e harnesses bind.
#
# WHY THIS EXISTS: the nuxt, sveltekit and astro harnesses each boot a REAL dev
# server on a FIXED port (`const port = …` in packages/*-e2e/test/*.e2e.ts).
# On a throwaway CI VM a leaked server dies with the VM, so nobody ever had to
# think about it. On a developer's machine (and for a hung harness within one CI run) — the
# host outlives the run: the workflow sets `cancel-in-progress`, and a cancelled
# job's dev-server child can survive its parent and keep holding the port. The
# NEXT run then dies with EADDRINUSE on a change that is perfectly fine, which
# reads as a flaky test suite rather than as leftover state.
#
# The ports are READ OUT OF THE HARNESSES rather than restated here, so moving a
# port cannot silently disarm this. Finding none is a failure, not "nothing to
# do" — that is precisely the case where the guard has stopped working and would
# otherwise stay green forever.
#
#   scripts/free-e2e-ports.sh          # kill anything listening, report it
#   scripts/free-e2e-ports.sh --check  # report only, never kill; exit 1 if held

set -uo pipefail
cd "$(dirname "$0")/.."

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

PORTS=$(grep -rhoE '^[[:space:]]*const port = [0-9]+' packages/*-e2e/test/*.e2e.ts 2>/dev/null \
  | grep -oE '[0-9]+' | sort -u)

if [ -z "$PORTS" ]; then
  echo "free-e2e-ports: found no 'const port = <n>' in packages/*-e2e/test/*.e2e.ts." >&2
  echo "  The harnesses moved or changed shape; this guard is no longer pointed at anything." >&2
  exit 1
fi

held=0
for port in $PORTS; do
  # -sTCP:LISTEN so a transient CLIENT connection to the port is never mistaken
  # for a leaked server and killed.
  pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null)
  [ -z "$pids" ] && continue

  held=1
  pidlist=$(echo "$pids" | tr '\n' ' ')
  if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "free-e2e-ports: port $port is held by pid(s) ${pidlist%% }"
    continue
  fi
  echo "free-e2e-ports: port $port was still held by pid(s) ${pidlist%% } — killing"
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null
done

if [ "$CHECK_ONLY" -eq 1 ] && [ "$held" -eq 1 ]; then
  exit 1
fi
exit 0
