#!/usr/bin/env node
// A stand-in "bugsee-cli" that simulates the process being killed by a SIGNAL (an OOM kill, or a
// cancelled CI job's SIGTERM landing on the child) — see docs/samples/PLAN.md §5.7g and
// packages/bundler-plugin-core/src/run-cli.ts's SIGNAL_EXIT_CODE.
//
// Pointed at via BUGSEE_CLI_PATH (the same escape hatch a locked-down/offline CI would use to supply
// its own binary — resolveBugseeCli() in run-cli.ts honors it unconditionally). Used by
// `pnpm build:signal-kill` to prove the regression guard: a child that never exits normally (`close`
// fires with `code: null`) must FAIL the build when `failOnError: true`, not silently report success
// (the historical `code ?? 0` defect this guards against).
//
// Ignores whatever args bugsee-cli would have received (`sourcemaps inject ...` / `debug-files upload
// ...`) and kills itself immediately with SIGKILL — the same shape of termination Node reports for an
// OOM-killed or forcibly-terminated child (`close` event: `code: null, signal: 'SIGKILL'`).
process.kill(process.pid, 'SIGKILL');
