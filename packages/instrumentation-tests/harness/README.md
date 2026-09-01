# Recovery invariant harness

`invariants.mts` sweeps the durable-upload / recovery subsystem against a fake collector and asserts
invariants about what may be delivered, kept and deleted. It is the safety net that caught the three
blocking defects fixed in round 6 (R5-1 live-path marker loss, R5-2 kill-state on 401/403, R5-3
collector-code namespace collision).

Run it: `pnpm exec tsx packages/instrumentation-tests/harness/invariants.mts` (~17 s, 350 cases).
Expected output: `350 cases swept, 0 invariant violations`.

## Why it lives here and not in `test/`

It is not a vitest suite — it is a single long-running sweep with its own oracle, and this package's
vitest configs glob `test/**`, so it is deliberately not collected. **It is not yet in CI.** Wiring it
in is a known follow-up; until then it must be run by hand before changing anything under
`core/src/{client,upload-pipeline,durable-upload-pipeline,capture-recovery,transport}.ts`,
`node/src/recover-instances.ts` or `browser-utils/src/coexistence.ts`.

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
