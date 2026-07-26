# Component-tree capture (the framework component hierarchy alongside the DOM) — design

Status: **DESIGN / FEASIBILITY.** Captured 2026-06-25 from a feasibility question. The foundation
(the `data-bugsee-component` annotation) is already built + on `main` (the frontend-adapters depth pass D2/
D3 — see `docs/design/frontend-adapters.md`); the report-time DOM/view-tree snapshot is also **built** (`@bugsee/browser` CE4 — `createDomSnapshot`/`createViewtreeSnapshotSource`, on `main`; `@bugsee/replay` is built RP0–RP6). The component-overlay integration (reading `data-bugsee-component` in the DOM-snapshot walk) is the one remaining follow-up item. This doc records the feasibility analysis, the
decision, and the recommended approach.

---

## 1. Context (understanding summary)

- The Bugsee **mobile** SDKs capture the native **view-tree (VT) hierarchy** as part of a report.
- The web analog is the **DOM tree** (bare HTML nodes), captured at report time as a snapshot.
- **The ask:** as we build framework adapters, also capture the **original framework COMPONENT tree** (the
  component hierarchy, like React/Vue DevTools shows) **alongside** the raw HTML tree — so a web report shows
  not just `<div><span>…` but `UserProfile › Avatar › <img>`.
- **Clarified constraint (user, 2026-06-25):** VT capture is performed **only upon reporting** (bug / error /
  crash) — a **one-time snapshot**, not continuous tracking. So there is **no continuous-tracking overhead**
  and no per-frame perf concern; the only question is "can we obtain the tree at report time," per framework.

**Non-goal:** continuous component-tree diffing / a DevTools-grade live inspector. This is a point-in-time
snapshot attached to a report.

---

## 2. Feasibility research (facts, primary-sourced 2026-06-25)

Two parallel research agents over the installed framework runtimes (`react@18.3.1`, `vue@3.5.38`,
`@angular/core@22.0.2`, `svelte@5.56.3`) + upstream source + official docs + competitor docs. The instinct —
walk framework internals like DevTools does — only survives contact with **production builds** for one
framework.

### 2.1 Can we walk framework internals to get the tree, in PRODUCTION?

| Framework | Prod component tree via internals? | Mechanism / why not (cited) |
|---|---|---|
| **React** | ✅ **Yes** | DOM nodes carry `__reactFiber$<randomKey>` written **unconditionally** (no `__DEV__` guard) by `precacheFiberNode` (`react-dom .../ReactDOMComponentTree.js`, identical in v18.3.1 + v19.0.0). From a host fiber, walk `.return` (parent) / `.child` / `.sibling`; `fiber.tag` distinguishes host (`HostComponent=5`) from component (`FunctionComponent=0`/`ClassComponent=1`) — exactly DevTools' `getClosestInstanceFromNode` + `getDisplayNameForFiber`. The `__REACT_DEVTOOLS_GLOBAL_HOOK__` is **not** auto-installed (React only reads a pre-existing one), so read fibers off DOM nodes directly. |
| **Vue 3** | ⚠️ **No, by default** | `__vueParentComponent` / `__vnode` are attached to elements only behind `process.env.NODE_ENV !== 'production' \|\| __VUE_PROD_DEVTOOLS__` (`@vue/runtime-core` `runtime-core.esm-bundler.js:1945,5698`). Every Vue 3.5.38 `*.prod.js` build has **zero** occurrences of `__vueParentComponent`. `__VUE_PROD_DEVTOOLS__` default = **false** (vuejs.org compile-time-flags). Only prod-stable handle = root `container.__vue_app__` → `app._instance` (top-down walk via `.subTree`/`.parent`), but **no per-DOM-node lookup**. |
| **Angular** | ❌ **No** | The `ng.*` debug API (`getComponent`/`getOwningComponent`/`getDirectives`) is published only under `ngDevMode && !COMPILED` (`@angular/core` `_debug_node-chunk.mjs` `publishDefaultGlobalUtils`), and the CLI **strips** these "debug features needed to communicate with DevTools" in production (angular.dev/tools/devtools). `__ngContext__` **is** written to prod DOM nodes (unconditionally, in `elementLikeStartShared`), so a raw LView/TView walk is *technically* possible — but it requires hard-coding undocumented `ɵ`-internal slot layout (`HEADER_OFFSET`, `ɵcmp`/`ɵdir`), carries **no names** (minified), and is on a surface Angular treats as removable. **Not SDK-grade.** |
| **Svelte** | ❌ **No tree exists** | Svelte compiles components to plain functions + DOM — there is **no persistent runtime component tree**. Every identity/structure hook is emitted `if (dev)` only: `Component[FILENAME]`, `component_context.function`, the `dev_stack` block tree, and the `__svelte_meta` DOM annotations (`svelte@5.56.3` `transform-client.js:348-361,534-541`; `internal/client/context.js`; `internal/client/dev/elements.js`). `component_context` is a transient module-level pointer (null outside a render), never on a global/DOM node, name-less in prod. Svelte 5 runes add signals, **not** a walkable named tree. |

### 2.2 What does the industry do? (none reconstruct a TREE)

Every competitor captures per-element component **names** via **build-time annotation** — **none** reconstruct
a component **tree**:
- **Sentry** — `@sentry/babel-plugin-component-annotate` injects `data-sentry-component` /
  `data-sentry-element` / `data-sentry-source-file` (same strategy as our `data-bugsee-component`); Svelte =
  the compile-time `componentTrackingPreprocessor`; Angular = user-applied `Trace*` decorators. Per-element,
  not a tree.
- **LogRocket** — relies on `.displayName`, warns minifiers strip names (recommends a display-name babel
  plugin). Per-component name for filtering, not a tree.
- **FullStory / Datadog** — component-name capture; tree reconstruction **UNVERIFIED** (their public docs
  describe naming, not hierarchy).

**Industry verdict:** framework component context comes from **build-time instrumentation / DOM annotation**,
not production runtime-internals walking.

### 2.3 The minified-name caveat (applies even to React)

Even where the *structure* is walkable (React fibers), the **names** come from `type.name` / `displayName`,
which minifiers mangle in production. Stable, human-readable names require a build-time source — which is
exactly what our `data-bugsee-component` annotation already provides (Vue's SFC `__name` + the babel plugin's
literal names survive minification).

---

## 3. Decision — derive the component tree from the DOM annotations at report time

**Reconstruct the component-ownership tree from the `data-bugsee-component` DOM attributes during the
report-time DOM/VT snapshot**, framework-agnostically — NOT by walking framework internals.

Rationale:
1. **It already works in production for all five frameworks.** The annotation lives on the DOM (emitted by
   the build plugin for React/Preact/Solid, the Vue mixin, the Svelte preprocessor — all on `main`), so it
   is immune to the prod-stripping that kills the Vue/Angular/Svelte internals routes.
2. **Stable names.** The build plugins emit literal component names → un-minified, unlike `type.name`.
3. **Framework-agnostic — one implementation.** The same DOM walk yields the component tree for every
   framework (and for any future framework that annotates). It matches the universal industry pattern.
4. **Zero added runtime cost.** The report-time DOM/VT snapshot already walks the DOM; reading one attribute
   per node and grouping is incremental work in the same pass.
5. **It is the literal ask** — "the component tree **alongside** the raw HTML tree" = the component-ownership
   overlay *on* the DOM tree.

### 3.1 How it works

During the report-time DOM/VT snapshot walk, each DOM node already maps to a VT node. Additionally:
- Read the node's nearest `data-bugsee-component` (self-or-ancestor — the existing
  `componentNameFromElement` resolver already does exactly this).
- Build a parallel **component-ownership tree**: collapse runs of DOM nodes owned by the same component into
  one component node; nest a child component under the parent component that owns the DOM region it renders
  into. The result is `UserProfile › Avatar › <img>` overlaid on the `<div><span><img>` DOM tree.
- Emit it alongside the VT/DOM snapshot in the report (the exact wire shape is defined with the VT snapshot
  format when that is built).

### 3.2 Limitations (honest)

- It is a **DOM-ownership tree**, not the full *logical* component tree. A pure pass-through component that
  renders only `<Child/>` with **no host element of its own** owns no DOM → it is invisible in the overlay.
  For VT/replay (mapping *visible* elements to components) this is exactly what's wanted; the invisible
  structural wrappers rarely matter.
- Coverage = whatever the build plugin/mixin annotated (**host elements**). Non-rendering components (context
  providers, fragments, render-prop wrappers) don't appear.
- Requires the annotation to be enabled (the babel plugin / Vue render-or-annotate mixin / Svelte
  preprocessor). With no annotation, the report still has the raw DOM tree — just no component overlay (graceful
  degradation; "no adapter" ≠ "unsupported", consistent with the baseline philosophy).

### 3.3 Optional enhancement — React Fiber walk (deferred, React-only)

At report time only, additionally walk the Fiber tree from the root (or from `__reactFiber$` on the snapshot
root) to recover the **full logical** tree, including the non-rendering / wrapper components the DOM-ownership
overlay misses — using `data-bugsee-component` for stable names where `type.name` is minified. Low marginal
value for VT purposes, React-only, fragile-ish (reads `__reactFiber$<randomKey>`); a clear "later if we want
higher fidelity on React" item, **not** part of the framework-agnostic baseline.

---

## 4. Prerequisite + sequencing

The one real prerequisite is the **report-time DOM / view-tree snapshot itself** — the `@bugsee/replay` /
view-hierarchy capture, now built (`@bugsee/browser` CE4, `createDomSnapshot`/`createViewtreeSnapshotSource`; `@bugsee/replay` RP0–RP6, on `main`). The component overlay is **not** a separate subsystem; it
rides on that walk. Sequencing:

1. Build the report-time DOM/VT snapshot (the view-tree-on-report capture — the web analog of mobile VT).
2. In the **same pass**, read `data-bugsee-component` per node and emit the component-ownership tree alongside
   (framework-agnostic; reuses `componentNameFromElement`).
3. (Optional, later) React Fiber-walk for full logical-tree fidelity.

Until step 1 exists, the annotation is already consumed at a smaller scale — interaction/error attribution
stamps `ui.component` from the same attribute (frontend-adapters D2). So the component data is *already*
captured per-event; the tree is the report-time aggregate of it.

---

## 5. Decision log

| Decision | Alternatives considered | Why |
|---|---|---|
| **Derive the tree from `data-bugsee-component` DOM annotations** | (a) Walk framework internals (React Fiber / Vue instances / Angular LView / Svelte context); (b) build-time inject a runtime tree-tracker (Sentry-Svelte style) | Internals-walking is prod-viable **only for React**; Vue strips the markers (default), Angular strips the debug API, Svelte has no runtime tree. The DOM-annotation route is the only **framework-agnostic, production-safe, stable-named** option — and reuses what's already built. Matches the universal industry pattern (Sentry/LogRocket/etc. all annotate). |
| **Snapshot at report time only** | Continuous component-tree tracking | User constraint; avoids all continuous-tracking overhead. A one-time DOM walk on report is cheap. |
| **Accept the DOM-ownership-tree limitation** (pure-wrapper components invisible) | Full logical tree via internals everywhere | The visible-element→component mapping is what VT/replay needs; full-logical-tree is React-only + fragile and adds little for VT. Offered as the optional React Fiber enhancement. |
| **Ride on the (future) report-time DOM/VT snapshot** | A standalone component-tree capture subsystem | The component tree is an overlay on the DOM tree; building it separately would duplicate the DOM walk. |
| **Graceful degradation when unannotated** | Require annotation | Consistent with the baseline philosophy — the raw DOM tree is always captured; the component overlay is the enrichment. |

---

## 6. Status of the foundation (already on `main`)

- `data-bugsee-component` emit: `@bugsee/babel-plugin-component-annotate` (React/Preact/Solid),
  `createBugseeVueComponentMixin` (`@bugsee/vue`), `@bugsee/svelte-plugin-component-annotate` (Svelte).
- `data-bugsee-component` read: `componentNameFromElement` (`@bugsee/browser`) — the nearest-annotated-ancestor
  resolver the overlay would reuse. Already wired into interaction/input attribution (`ui.component`).
- **Built:** the report-time DOM/VT snapshot consumer (`@bugsee/browser` CE4 — `createDomSnapshot`/`createViewtreeSnapshotSource`, on `main`; `@bugsee/replay` RP0–RP6 also on `main`).
- **Remaining follow-up:** folding the `data-bugsee-component` overlay into the DOM-snapshot walk (step 2 in the sequencing above).
