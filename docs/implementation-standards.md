# Bugsee JavaScript SDK — Implementation Standards

**Status:** v1 (2026-05-25)
**Binding for:** all code in this repository. Summary lives in `CLAUDE.md`; this is the full methodology. Aligns with the architecture in `docs/design/sdk-design.md` (testing tooling in §12.1/§13).

These standards exist because the SDK runs in customers' production apps across many runtimes. "It compiles and the happy path works" is not enough — tests must *prove* behavior and *prove they would catch regressions*. Coverage measures what executes; the mutator discipline measures whether the assertions actually validate.

---

## 1. Test-first (TDD)

- **No production code is written before a failing test that requires it.** Red → green → refactor.
- **Every file, method, getter, setter, and line** is covered by one or more tests.
- Tests must **comprehensively validate**, not merely execute: assert return values, state changes, emitted events, error paths, and boundary/edge inputs. A test that calls a method but asserts nothing meaningful does not count, even though it raises coverage.
- One behavior per test where practical; name tests by the behavior they pin (`emits NetworkEvent on fetch start`, not `test fetch`).

## 2. The mutator loop (per testable entity)

Applied each time a **testable entity** (method, getter, setter, pure function) is created or changed. This is a **development-time, hand-driven** loop — distinct from the opt-in Stryker run (§5).

```
1. Write the test for the new/changed behavior.
2. Add the minimal implementation.
3. Run the test → confirm GREEN.
4. Mutator loop (max 10 iterations):
     a. Inject ONE bug into the entity under test (see mutation catalog below).
     b. Run the covering test(s).
     c. Expect RED. If RED → the test caught the mutation; revert this mutation, try a different one.
        If GREEN → the test is too weak: STRENGTHEN the test (add or tighten an assertion),
        revert the mutation, and re-run from step 3.
     d. Stop when you run out of meaningful mutations OR hit the 10-iteration hard limit.
5. Roll back EVERY injected mutation. The working tree must end on the clean, correct implementation.
   Never commit, push, or leave a mutation in place.
```

**Mutation catalog** (inject one at a time):
- Flip a conditional (`>` ↔ `>=`, `===` ↔ `!==`, `&&` ↔ `||`).
- Negate a boolean / remove a `!`.
- Off-by-one on an index, length, or boundary.
- Return a constant / `null` / `undefined` instead of the computed value.
- Swap arguments to a call; drop a function call (e.g. omit `emit(...)`, `unsubscribe(...)`, a sanitizer pass).
- Change a literal (string token, numeric cap, default value).
- Remove a `break`/`return`/`throw`; skip an error path.
- Replace a math/string op (`+` ↔ `-`, `*` ↔ `/`, slice bounds).

**Discipline:** mutations are scoped to the entity just implemented/changed — don't mutate unrelated code. The 10-iteration cap prevents infinite loops; if you've exhausted meaningful mutations sooner, stop early.

> **Why hand-driven and not just Stryker?** The loop gives instant, local feedback *while you write the test*, and forces you to think like an attacker on the exact lines you just wrote. Stryker (§5) is the automated, exhaustive audit — slower, run separately.

## 3. Integration tests

Beyond unit tests, add **integration tests** for:
- Any class that **interacts with other classes** (e.g. a `CaptureProvider` subscribing to an event hub and pushing to the aggregator; the `UploadPipeline` driving `BugseeApi` + `BundleUploader`).
- Any **cross-module / cross-package import/export boundary** (e.g. `@bugsee/browser` registering services into `@bugsee/core`; an `Extension` registering providers via `registerExt`).

Integration tests follow the **same mutator discipline (§2)** — inject bugs at the seam (wrong wiring, dropped event, mis-ordered call, unsubscribed listener) and confirm the integration test catches them. Prefer real collaborators over mocks at the boundary under test; mock only the runtime edge (network, fs, DOM, timers).

## 4. Coverage gate (CI)

- **100% line, ≥90% branch**, enforced in CI and **measured per target runtime** (browser/node/bun/deno/workers/…), since platform branches only execute on their own runtime. Coverage is the union/per-package view appropriate to each package's runtime(s).
- Tooling: Vitest coverage (v8 provider).
- **Exclusions are the only escape hatch and require justification.** Unreachable defensive branches or platform-guarded code may be excluded with an explicit annotation **and a one-line reason**:
  ```ts
  /* v8 ignore next 3 -- platform guard: only reachable on Deno, covered in deno smoke suite */
  if (isDeno) { ... }
  ```
  No blanket file-level ignores without review. Excluded lines are still expected to be covered by the relevant per-runtime smoke suite where possible.

## 5. Mutation testing (Stryker) — opt-in

- **Stryker is configured per package** (Vitest runner) but is **NOT a blocking CI gate**.
- Run it **on demand or on a nightly/pre-release job** to audit overall test strength and surface weak spots the hand loop missed.
- It complements, and never replaces, the per-entity mutator loop (§2), which remains the always-on discipline.
- When Stryker surfaces a surviving mutant, treat it like a failed §2 loop: strengthen the test, don't weaken the mutator config.

## 6. Tooling summary

| Layer | Tool |
|---|---|
| Unit + integration | Vitest (`--typecheck` for type-level contracts) |
| Browser e2e | Playwright |
| Per-runtime smoke | `bun test` / `deno test` / `wrangler dev` / Vercel CLI harnesses (`dev-packages/`) |
| Coverage | Vitest + v8 provider (100% line / ≥90% branch, per runtime) |
| Mutation (opt-in) | Stryker Mutator (Vitest runner) |
| Wire-format | Vitest snapshots in `dev-packages/wire-snapshots/` (snapshot update requires a `backend-ref:` commit line — design §13) |

---

## 7. Multi-agent code review (per feature) — convergent gate

After a feature's implementation **and** tests are complete and all automated gates pass (§2 mutator loop, §4 coverage, typecheck, lint), it must clear a **multi-agent code review** before it is considered done. Automated gates prove the tests are strong; this review proves the *design, correctness, and test adequacy* are sound — things a coverage number cannot.

### 7.1 Spawn multiple specialized agents in parallel

Both the implementation **and** the tests are under review. Run, at minimum:

- **Implementation reviewer** — correctness, edge cases, error handling, async/concurrency, security & privacy (sanitizer/PII per design §14), resource/lifecycle handling, and conformance to the design doc and the public API contract.
- **Test reviewer** — whether tests *validate* behavior rather than merely execute it; missing cases and boundaries; weak, oracle-free, or tautological assertions; over-mocking that hides real behavior; flakiness/nondeterminism; and whether the mutator-loop intent is genuinely met.
- **Standards / design-conformance reviewer** (for cross-cutting or cross-package features) — adherence to the architecture (thin kernel, pub/sub, no core piercing — §0.6/§16), naming, layering, and these standards.

Use distinct agents so perspectives don't collapse into one. The reviewed surface includes the diff **and** its immediate collaborators.

### 7.2 Rules of engagement (non-negotiable, passed to every review agent)

- **No assumptions.** If behavior or intent is unclear, read the code, the design doc, and the tests until certain. Never guess.
- **No hallucination.** Every finding cites a concrete `file:line` and a verifiable reason; if a claim can be checked by running code or tests, run it.
- **No shortcuts / easy paths.** Validate everything thoroughly. When confused, **re-check** rather than hand-waving; prefer reproducing over reasoning-from-memory.
- **Read-only.** Review agents report findings; they do **not** edit code. Fixes are applied by the orchestrator.

### 7.3 Triage, fix, and re-review (loop to convergence)

1. **Triage** each finding into *real issue* vs *false positive*; record a one-line reason for every dismissal (so dismissals are auditable, not silent).
2. **Fix real issues test-first**: write a failing test that reproduces the issue, fix it, then run that entity's §2 mutator loop and re-check the §4 gates.
3. **Re-review**: start a **fresh** multi-agent review (new agents, full scope) over the updated feature.
4. **Repeat** 1–3 until a full round produces **zero new real findings**. Only then is the feature done.

### 7.4 Guardrail

If the loop does not converge after several rounds (fixes keep surfacing genuinely new real issues), **pause and surface the situation to the user** with the open findings rather than thrashing. (Analogous to the §2 mutator loop's hard iteration cap — convergence is the goal, not infinite churn.)

---

## Checklist (per change)

- [ ] Failing test written first.
- [ ] Implementation added; test green.
- [ ] Mutator loop run on each new/changed entity (≤10 iters); weak tests strengthened.
- [ ] All injected mutations rolled back; tree is clean.
- [ ] Integration tests added for new class interactions / module boundaries (with their own mutator loop).
- [ ] Coverage 100% line / ≥90% branch on the relevant runtime(s); any exclusion annotated + justified.
- [ ] Multi-agent review (§7) run; real findings fixed test-first; re-reviewed until a round has zero new findings.
