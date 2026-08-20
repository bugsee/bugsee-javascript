# Mutation testing and property-based tests

Two audit layers that sit **beside** the binding disciplines in `docs/implementation-standards.md`, not
instead of them. The per-entity mutator loop (§2) and the 100%-line coverage gate (§4) remain the
always-on rules; these catch what those structurally cannot.

| | Catches | When it runs |
|---|---|---|
| Per-entity mutator loop (§2) | A weak test **at the moment the entity is written** | Every change, by hand |
| Coverage gate (§4) | Code no test executes | Every commit, CI |
| **Mutation testing** (Stryker) | A test that rotted **after** it was written, and code that is executed but not *asserted on* | On demand |
| **Property-based tests** (fast-check) | Inputs nobody thought to write down | Every `pnpm test` |

## Mutation testing

Opt-in, per package, never a CI gate — a full run costs minutes per package:

```
pnpm test:mutation util          # one package (directory name under packages/)
pnpm test:mutation capture
```

`scripts/mutation.mjs` runs Stryker from the package directory using the shared root
`stryker.config.json`. It has to work this way: the vitest runner plugin lives only in the workspace
root `node_modules` (pnpm keeps package installs isolated), while Stryker resolves the `mutate` globs
relative to the working directory. The report lands in `packages/<pkg>/reports/mutation/`.

### Reading the result

A surviving mutant is a **question**, not automatically a defect. Triage each one; the three answers are:

1. **A real gap** — the code is executed but nothing asserts the behavior. Strengthen the test.
2. **An equivalent mutant** — the mutation cannot change observable behavior, so no test can kill it.
   Leave it, and record it below.
3. **Dead weight** — the code itself is unnecessary. Delete it.

### Excluding what should not be mutated

`*.test-d.ts` — vitest TYPE tests — must be excluded alongside `*.test.ts`. They never execute under the
normal run, so every mutant in them reports `NoCoverage` and drags the score down for no reason: in
`@bugsee/protocol` that was 178 mutants hiding ~20 points, and it also understated `core`,
`opentelemetry` and `types`. Read the score with that in mind when comparing against any figure recorded
before 2026-08-20.

### Known equivalent mutants

Recorded so they are not re-triaged every run. `@bugsee/util` sits at **97.95%**; all five survivors are
equivalent:

- `backoff.ts` (3) — `attempt > 0 ? attempt : 0` → `>= 0`, and the same shape twice more. On the boundary
  both branches yield the identical value, so no input distinguishes them.
- `base64.ts` (1) — the loop bound `i < binary.length` → `i <= binary.length`. The extra iteration writes
  `NaN` one past the end of a `Uint8Array`, and an out-of-bounds typed-array write is silently discarded.
- `env.ts` (1) — dropping the optional chain in `g.process?.type` on the right of an `&&` whose left
  operand already dereferenced `g.process?.versions?.electron`. If `process` is undefined the left side is
  `false` and short-circuits, so the right side is unreachable in exactly the case the `?.` guards.

**`@bugsee/protocol` (84.09%)** — most of the remaining `sanitize.ts` survivors are REDUNDANCY rather
than gaps, and that is the design: the passes deliberately overlap so no single detection step is
load-bearing. Verified by injection, not assumed — disabling JSON content-type detection entirely, or
multipart detection entirely, leaks nothing, because `looksLikeJson` and the textual form/colon passes
cover the same ground. The `%XX` alternative in the anchored JWT boundary is the same story: no input
could be constructed where removing it changes the outcome.

The useful conclusion from that: a surviving mutant here means "no test could tell", and since the leak
properties run against every mutant, it also means "this mutation does not leak". Chase the survivors that
change WHAT IS REDACTED, not the ones that change WHICH PASS DID IT.

### A score that does not move is not the same as tests that add nothing

Adding the `node` coexistence properties left `liveness.ts` at 6 survivors and moved the package score
slightly DOWN (89.56% → 88.99%). Neither figure means what it looks like:

- The mutants those properties kill were **already killed**. What the properties add is protection against
  a change mechanical mutation cannot express — deleting the whole main-thread branch, which re-introduces
  the SIGSTOP data-loss regression. Verified by injecting it: the properties fail.
- The survivors left in `isSiblingDead` are **equivalent**. Removing the explicit
  `liveMtimeMs === undefined` guard changes nothing, because the fall-through reaches the main-thread check
  (which returns false) or evaluates `NaN > patientMs` (also false). Checked exhaustively over 192
  alive/heartbeat/now/patience/threadId combinations: zero disagreements. The guard is defensive clarity.
- The survivor SET differs run to run even when the count does not — `liveness.ts` swapped an L33
  `ConditionalExpression` for an L38 `OptionalChaining` between two runs of the same code. Stryker's
  per-test mapping shifts when the test set changes, so treat small score movements as noise and compare
  the survivors themselves.

Judge a mutation run by which survivors are real, not by the percentage.

### A property that iterates a list cannot defend that list

`SENSITIVE_HEADERS` and `SENSITIVE_KEY_SUBSTRINGS` are walked by several properties, so deleting an entry
keeps them all green — the property and the data move together. Twenty such deletions survived. Lists that
are a product promise have to be pinned BY VALUE somewhere, and the same applies to `DEFAULT_FILENAMES`,
which is half of a cross-process contract.

## Property-based tests

`*.fuzz.test.ts`, run as part of the normal suite (a few hundred cases each) so a regression surfaces in
the same commit rather than overnight. They target the code that reads input the SDK does not control:
the W3C trace-context codec (headers from a remote peer), the tier-0 primitives, and the target-masking
rules that carry the privacy guarantee.

Prefer **differential** and **invariant** properties over restating the implementation — `utf8ByteLength`
is compared against `TextEncoder`, and the two sha256 paths against each other. A counterexample is then
a defect rather than a changed opinion.

### Writing generators that actually reach the bug

Every real defect this suite found needed the generator strengthened first. In each case the property was
already correct and the input was too weak — a generator that cannot construct the failure is
indistinguishable from a passing implementation.

- **Name the boundaries.** A uniform pick from the 2048-value surrogate range essentially never produces
  `0xDBFF` immediately followed by a low surrogate, so narrowing `code <= 0xdbff` to `<` survived. Draw
  the edges explicitly with `constantFrom`.
- **Set `minLength`, not just `maxLength`.** fast-check biases toward small values, so `maxLength: 40`
  spent nearly every run on 0–5 entries — far under the 512-byte cap being tested, making the property
  vacuously true.
- **Mutate a VALID input.** Random strings never land inside a rigid grammar, so an implementation
  accepting *any* non-empty trace id survived. Corrupting one field of a valid header puts the input on
  the boundary each individual check defends.
- **Use distinctive needles for leak checks.** Asserting the output does not *contain* a generated secret
  fails spuriously when the secret is `"a"`, which occurs inside `"masked"`.
- **Reach for real multibyte.** `fc.string({unit:'grapheme'})` produced overwhelmingly ASCII and passed
  against a cap that emitted 934 bytes for a 512-byte limit.

### Mutation-verify the properties themselves

A property test can be decorative in exactly the way an example test can. Every property here was checked
by injecting the bug it claims to catch and confirming it fails — including reverting each of the fixes
these suites produced.
