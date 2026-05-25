# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

This repository is the new **Bugsee JavaScript SDK**. It is intended to be a single SDK that targets every JavaScript runtime: browsers (web), Node.js, Bun, Electron, and any other environment where JS executes.

Design implication: runtime-portable code is the default. Anything runtime-specific (DOM APIs, `process`, `window`, `fs`, Electron's `app`/`BrowserWindow`, Bun-only APIs, etc.) belongs behind a runtime adapter or a conditional entry point — never imported unconditionally from shared code.

## Current state

No source code yet, but the architecture is fully specified in **`docs/design/sdk-design.md`** (Draft v3) — read it before writing any code. There is no build/test/lint command to document yet.

Planned toolchain is consolidated in **`docs/dev-environment.md`**. When code lands, update this file with:
- Package manager and the actual build/test/lint commands (including how to run a single test) — also fill the "Commands" section of `docs/dev-environment.md`
- The chosen module strategy for multi-runtime support (`exports` conditions; see design §6/§12.2)
- The runtime-adapter pattern (where the runtime is detected, how platform-specific code is isolated)

## Design (must-follow)

- **Android-canonical.** The Bugsee Android SDK (`/Users/alexeykarimov/Projects/Bugsee/android/sdk`) is the API **and** architecture parity target. Sentry/Firebase are studied as internal design references only — **never** migration sources; do not add migration guides/aliases for them.
- **Thin kernel + pub/sub event flow** (Android-derived): sources (interceptors/adapters) → event hubs → capture/detection providers → cyclic ring buffers → bundle. Features are **pluggable extensions**; **do not pierce the core** (e.g. APM is the opt-in `@bugsee/performance` extension, not core code). Full contract in design §16.
- **Runtime-portable by default.** Anything runtime-specific (DOM, `process`, `window`, `fs`, Electron, Bun/Deno APIs) lives behind a runtime adapter or conditional entry point — never imported unconditionally from shared code.

## Implementation standards (binding — full methodology in `docs/implementation-standards.md`)

Mandatory for all code:

1. **Test-first (TDD).** No implementation without a failing test first. Every file, every method/getter/setter, and every line must be covered by one or more tests that **comprehensively validate** behavior (assert outcomes), not merely execute it.
2. **Mutator loop, per testable entity.** When creating/changing a method/getter/setter:
   1. Write the test → 2. add the implementation → 3. run it, confirm pass →
   4. **Mutator loop:** inject a bug into the new/changed entity, run the test, confirm it **fails** (catches the bug); repeat with different mutations while any mutation survives undetected — **hard limit: 10 iterations**. If a mutation survives, strengthen the test before continuing.
   5. **Roll back every injected mutation**, leaving the clean, valid implementation. Never commit a mutation.
3. **Integration tests.** Any class that interacts with other classes, or any cross-module/cross-package import/export boundary, gets integration tests following the same mutator discipline (#2).
4. **Coverage gate (CI, per-runtime):** **100% line, ≥90% branch.** Coverage runs per target runtime (browser/node/bun/deno/…). Unreachable or platform-guarded code may be excluded only via an explicit `/* v8 ignore … */` annotation **with a one-line justification**.
5. **Mutation testing (Stryker): opt-in**, not a blocking gate — run on demand/nightly to audit test strength. The per-entity mutator loop (#2) is the always-on primary discipline.
6. **Tooling:** Vitest (unit + integration, `--typecheck` for type tests), Playwright (browser e2e), per-runtime smoke harnesses. See design §12.1/§13.
