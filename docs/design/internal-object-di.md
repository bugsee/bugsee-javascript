# Internal object & DI/IoC — realization note

**Status:** agreed direction (2026-05-30). Spec lives in `sdk-design.md` §4.2/§4.4/§7.4 (§198, §210,
§238, §294, §302); this note is the concrete as-built plan + phasing for the JS monorepo. Read with
the memory `sdk-di-ioc-architecture-vision`.

## The two singletons (Android `Bugsee` / `BugseeInternal`)

| Layer | Android | JS | Notes |
| --- | --- | --- | --- |
| **Facade** (public) | `Bugsee.java` | the object `launch()` returns (the `BugseeClient` surface) | Owns no logic; delegates. Per-platform it can ADD methods (browser-only `showReportDialog`, …), typed via declaration-merging. |
| **Internal aggregated object** | `BugseeInternal.java` | the **Client's `ServiceContainer`** (`@bugsee/service`) + the Client's own state (Environment, coordinators, pipelines) | Holds all state + **incorporates** the functional components as **services** resolved by contract. Per-platform it incorporates different concrete components. |

Both are **per-process singletons**. The carrier (#47, `globalThis.__BUGSEE__[version]`) already holds
the singleton client (slice C); the client owns its container. So the internal object is reachable
process-wide **through the carrier's client** — we do **not** add a global services map (design §238:
"No global `_components` map — per-Client container only"). `carrier ↔ client ↔ container` is 1:1.

## DI / IoC

- **The container exists and is done:** `@bugsee/service` — `createServiceContainer()`,
  `defineService(name, factory, mode)` (LAZY default / EXPLICIT), `Provider` (lazy `get`/`getImmediate`,
  deps resolved from the container = IoC, `onInit`, late registration via pending-Deferred,
  `clearInstance`). Single-instance, no global registry, no EAGER. We **host and use** it — not rebuild.
- **Contract-first services** = the replaceable platform implementations (design §198): `Transport`,
  `Storage`, `SystemProbe`/`Platform`, `Clock`, `IdGenerator`, `BundleWriter`, `Logger`, `StackParser`,
  and SDK state like **redaction filters**. The contracts already exist in the codebase as the
  injectable seams (`HttpTransport`, `CaptureStore`/`FileStorageAdapter`, `BundleStore`, `SystemProbe`,
  `Clock`, `Scheduler`) — today hand-wired in `launch()`; the migration is to **register** them and let
  the container **resolve** them lazily.
- **Typed without hard-listing** (design §302): `NameServiceMapping` (empty, declaration-merged) lives
  in **`@bugsee/types`** (zero-dep tier-0). `@bugsee/service` stays generic/untyped; **`@bugsee/core`'s
  `Client.addService`/`getService`** are the `NameServiceMapping`-typed facade. A platform package
  declaration-merges its services into `NameServiceMapping`, so `client.getService('transport')` is
  typed in core without core importing the node impl. This is "auto-registered, not hard-declared".
- **No import-time registration** (design §294): platform packages register services imperatively from
  `launch()`/`register(client)`, never at module load — keeps `sideEffects:false` honest.

## What stays carrier-global vs. per-client

- **Carrier-global** (process singletons, NOT per-client services): the **interceptors** — they patch
  process globals (`fetch`/`console`/…) so there must be exactly one per process regardless of client
  churn (already correct, #47). The singleton **client ref** (C).
- **Per-client container** (the internal object): everything that is the SDK *instance's* components +
  state — transport, storage, env, pipelines, **filters**, etc.

## Phasing (incremental; each a normal plan → TDD → mutator → review → commit slice)

**Phase 1 — stand up the internal object + typing (zero migration risk).**
- `NameServiceMapping` (empty) in `@bugsee/types`.
- The Client owns a `ServiceContainer`; add typed `addService(service)` / `getService(name)` /
  `getServiceProvider(name)` to `BugseeClient` (the typed facade over the generic container).
- Expose the container to in-process consumers via the carrier's client (a `getInternal(carrier)`
  helper resolving `carrier.client`'s container) — no new global slot.
- Prove end-to-end: register a service, resolve it (lazy + late registration + declaration-merged
  typing) — **without** migrating any existing wiring.

**Phase 2 — filters as the first real service (delivers E).**
- A `filters` service/state on the container (network/log/breadcrumb/report). Facade `set*` delegate;
  the capture-pipeline providers read it via the carrier's client container. (Supersedes the paused
  ad-hoc "carrier filter slot" approach.) Includes the default-sanitizer gating.

**Phase 3 — migrate the platform seams to services.**
- `Transport`/`Storage`/`SystemProbe`/`BundleWriter`/… become registered services; `launch()` registers
  the node impls and the container assembles. `addService`/`getService` become public (audit gap). Then
  resume **F** (network body capture) on the new substrate.

## Reuse / current → target map

| Current | Target |
| --- | --- |
| `@bugsee/service` `createServiceContainer` (built) | the internal object's registry |
| hand-wired seams in `launch.ts` (transport/store/probe/...) | registered services, resolved by the container (Phase 3) |
| `carrier.client` (C) | the reachability path to the container (Phase 1 `getInternal`) |
| `NameExtensionMapping` pattern (`@bugsee/types`) | mirror for `NameServiceMapping` |
| ad-hoc "filters on carrier" (paused) | `filters` service in the container (Phase 2) |

## Verification (per slice)
Per-package vitest + `pnpm test`/`typecheck`/`lint`/`check:cycles`/`test:coverage`; per-entity mutator
loop; multi-agent convergent review; PROGRESS.md + memory updates. The whole point is that each phase
keeps the existing Node SDK green while the composition moves under it.
