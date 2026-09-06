# Recovery invariant harness

`invariants.mts` sweeps the durable-upload / recovery subsystem against a fake collector and asserts
invariants about what may be delivered, kept and deleted. It is the safety net that caught the three
blocking defects fixed in round 6 (R5-1 live-path marker loss, R5-2 kill-state on 401/403, R5-3
collector-code namespace collision).

Run it from the repo root: `pnpm exec tsx packages/instrumentation-tests/harness/invariants.mts`
(~30 s, 369 cases). It resolves the packages it exercises from its OWN location, so it can be run
from a git worktree and will validate THAT tree — but only if the worktree's dependencies are its
own. A worktree whose `node_modules` are symlinked to the main checkout resolves `@bugsee/*` back
to the main tree, and the harness then certifies code that is not the code under test.
Expected output: `369 cases swept, 0 invariant violations`.

## Why it lives here and not in `test/`

It is not a vitest suite — it is a single long-running sweep with its own oracle, and this package's
vitest configs glob `test/**`, so it is deliberately not collected. **It is not yet in CI.** Wiring it
in is a known follow-up; until then it must be run by hand before changing anything under
`core/src/{client,upload-pipeline,durable-upload-pipeline,capture-recovery,transport}.ts`,
`node/src/recover-instances.ts`, `core/src/bugsee-api.ts`, `browser-utils/src/coexistence.ts` or
`browser-utils/src/recover-dead-instances.ts`.

## The one rule that must not be broken

**The oracle must never import an SDK predicate** — not `isRetryableHttpStatus`, not `isUploadSettled`.

Two earlier versions of this harness were wrong in exactly that way and certified broken code:

- v1 keyed an invariant on `reportId ?? 'anon:' + summary`, so a legacy blob and its own marker's rebuild
  counted as two different incidents. It swept the violation and discarded it.
- v2 computed `settledOk = ok || permanent` — i.e. it assumed the policy under test. Re-injecting the
  SEV1 classifier bug produced **0 violations across 231 cases**.

The current version does not classify a status at all. The fake collector **declares its intent** per
answer (`Answer`/`ANSWERS`) and then **behaves that way** — an answer it called `transient` really clears
by launch 3; one it called `refuse` never does. Every invariant reads the recorded intent. A
mis-transcription of Android's rules therefore shows up as an *outcome* (the collector offering to take
bytes the SDK threw away, or the SDK re-asking about bytes finally refused) rather than being invisible
because both sides made the same mistake.

Independence of provenance is not enough. It has to be independence of outcome.

## The one licensed exception to P2

P2 says nothing may be deleted that the collector has not first taken or refused. **Retention is the
single exception**, because giving up on a blob is by definition deleting one the collector never
answered about. Set N (the browser/worker age bound) therefore carries its own explicit assertions
instead of being routed through `judge` — weakening P2 for everyone to accommodate it is how a real
loss would hide. Every other artifact in those cases is still judged normally, and the `no timestamp`
control in that set is the safety rail: an unknown staging time must NEVER expire, or the launch after
an SDK upgrade deletes every pending crash report. Injecting `firstSeenMs ?? 0` there is caught by the
pre-existing P2 in set H, 23 times over.
