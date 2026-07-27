# Adversarial review — @bugsee/babel-plugin-component-annotate

**Reviewed:** 2026-07-26 · **Scope:** packages/babel-plugin-component-annotate (impl 100 LOC, tests 131 LOC)

**Verdict:** The transform is **substantially correct and non-corrupting**. Across 31 adversarial JSX
constructs and 5 real preset pipelines I could not produce a single case of invalid output, dropped
attributes, lost source-map fidelity, double annotation, or an infinite visitor loop — and the
producer/consumer contract with `@bugsee/browser` matches byte-for-byte. **No SEV1.** The one real defect is a
**re-entrancy hazard in the shared per-instance closure** (SEV2): a peer plugin that performs a nested
`transformSync` mid-traversal (the `babel-plugin-macros` / `preval` / `codegen` family) triggers this
plugin's `pre()` on the *shared* instance, silently wiping the component stack and dropping every remaining
annotation in the outer file — proven empirically (2 expected annotations → 0). The rest is test strength:
coverage is a *green 100%/100%* that overstates real assurance. **5 of 5 targeted mutations survived the
suite** (2 controls were correctly caught, proving the harness). The headline example is genuine test
theater — the test named `annotates EACH host element with its OWN defining component (nested components)`
contains **siblings, not nested components**, so replacing "innermost component" with "outermost component"
(`componentStack[0]`) or `pop()` with `shift()` passes all 14 tests. TypeScript is entirely untested despite
`.tsx` being the primary target, and there is no integration test against a real JSX transform.

---

## SEV1

None.

---

## SEV2

### 1. Re-entrancy: `pre()` wipes the shared component stack mid-traversal, silently dropping annotations

- **Where:** `packages/babel-plugin-component-annotate/src/index.ts:65` (the shared closure) and
  `packages/babel-plugin-component-annotate/src/index.ts:77-79` (`pre()` resetting it)
- **What:** `componentStack` is a single closure variable per plugin *instance*, reset in `pre()`. Babel
  caches one instance across an entire build, so `pre()` is the only isolation boundary. That boundary is
  **not re-entrant**: if any peer plugin runs a nested `babel.transformSync(...)` from inside its visitor —
  and that nested config includes this plugin (which it does whenever the nested compile reuses the parent's
  options, the standard idiom for `babel-plugin-macros`, `babel-plugin-preval`, `babel-plugin-codegen`) —
  the nested `pre()` executes **while the outer file is still being traversed** and sets
  `componentStack = []`. Every subsequent `JSXOpeningElement` in the outer file then sees an empty stack and
  hits the `if (current === undefined) return;` early-out at `index.ts:88`.
- **Why it matters:** Silent, total loss of component attribution for the remainder of the affected file.
  There is no error, no warning, and the build succeeds — `ui.component` simply goes missing for those
  elements, and the planned component-tree capture loses those nodes. It fails *closed* (no wrong names, no
  corrupted output: the unbalanced `exit` pops an already-empty array, which is a safe no-op), which is why
  it is SEV2 rather than SEV1 — but it is undetectable in production without diffing build output.
- **Evidence:** Ran the real source (via `tsx`) with a peer plugin that does a nested `transformSync` on the
  same instance:
  ```
  IN : function Outer(){ INNER(); return <div><section/></div>; }
  OUT: function Outer() { inner_done(); return <div><section /></div>; }
        → annotations = 0   (expected 2: <div> and <section> as "Outer")
  ```
  Note the *sequential* multi-file reuse case IS handled and IS tested (`index.test.ts:85-112`); only the
  nested/re-entrant case fails. I also empirically **cleared** the adjacent concurrency worry: 40 files
  transformed via concurrent `transformAsync` on one shared instance produced 0 cross-file leaks, so the
  "babel transforms sequentially per plugin instance" comment at `index.ts:63-64` holds for concurrency —
  it is only nesting it does not cover.

---

## SEV3

### 1. Test theater: the "nested components" test contains siblings, so innermost-vs-outermost is unverified

- **Where:** `packages/babel-plugin-component-annotate/src/index.test.ts:34-40`
- **What:** The test is named `annotates EACH host element with its OWN defining component (nested
  components)` but its input is `function A() { … } function B() { … }` — two **top-level siblings**. The
  component stack is therefore never deeper than 1 in the entire suite, so nothing distinguishes "top of
  stack" from "bottom of stack".
- **Why it matters:** The two core stack operations are unverified. Mutating `index.ts:87` to
  `componentStack[0]` (attribute to the OUTERMOST component instead of the enclosing one) and mutating
  `index.ts:72` `pop()` → `shift()` both leave **all 14 tests passing**. Either bug would silently
  mis-attribute every host element in a file that defines a component inside another component — a common
  React shape — sending the wrong component name to the backend.
- **Evidence:** Mutation harness (controls first, to prove it works):
  ```
  MUT [CONTROL isComponentName accepts lowercase] : CAUGHT (4 failed)
  MUT [CONTROL hasAttribute always false]         : CAUGHT (1 failed)
  MUT [value = componentStack[0]]                 : *** SURVIVED ***
  MUT [stack.shift() instead of pop()]            : *** SURVIVED ***
  ```
  The real behaviour is correct — verified manually, just not by the suite:
  `function Outer(){ function Inner(){ return <b/>; } return <div><Inner/></div>; }` →
  `<b data-bugsee-component="Inner">` and `<div data-bugsee-component="Outer">`.

### 2. Attribute ORDER relative to a spread is load-bearing but untested

- **Where:** `packages/babel-plugin-component-annotate/src/index.ts:92` (`attributes.push(...)`)
- **What:** `push` places the annotation **last**, which after the JSX transform compiles to
  `_extends({}, props, { "data-bugsee-component": "A" })` — i.e. the annotation always wins over a spread.
  That is the correct choice, but nothing tests it: mutating `push` → `unshift` survives the suite.
- **Why it matters:** With `unshift`, any `<div {...props}/>` whose props happen to carry the key would have
  the annotation clobbered at runtime, silently disabling attribution for spread-heavy components. No test
  would notice. There is no spread test case at all.
- **Evidence:** `MUT [push attribute BEFORE existing attributes (unshift)]: *** SURVIVED ***`; compiled
  output confirmed as `React.createElement("div", _extends({}, props, { "data-bugsee-component": "A" }))`.

### 3. Inconsistent precedence: a literal user attribute is respected, a spread-carried one is overridden

- **Where:** `packages/babel-plugin-component-annotate/src/index.ts:52-59` (`hasAttribute`) vs `:92`
- **What:** `hasAttribute` only inspects literal `JSXAttribute` nodes. A user's own
  `<div data-bugsee-component="Manual">` is preserved (correct, tested at `index.test.ts:121`), but
  `<div {...{"data-bugsee-component":"User"}}/>` gets a second annotation appended that **wins at runtime**.
- **Why it matters:** Low blast radius (users rarely set our attribute via spread), but the two paths
  disagree about who owns the value, and neither the README nor the tests state the rule.
- **Evidence:** `<div {...{"data-bugsee-component":"User"}}/>` →
  `<div {...{ "data-bugsee-component": "User" }} data-bugsee-component="A" />`.

### 4. Untested: lowercase const assigned a NAMED function expression

- **Where:** `packages/babel-plugin-component-annotate/src/index.ts:44`
- **What:** The "assigned-const name wins, and if it is not PascalCase the whole thing is not a component"
  rule is only tested with an **arrow** (`index.test.ts:80-83`, `const renderRow = () => <tr/>`). An arrow
  has no `id`, so the fallback at `index.ts:46-48` returns `undefined` regardless — the test cannot
  distinguish the two behaviours. Mutating line 44 to fall through to `node.id` survives.
- **Why it matters:** With that mutation, `const renderRow = function Row(){ return <tr/>; }` would be
  annotated `"Row"` — leaking a helper's internal name as a component. Current behaviour is correct
  (verified: produces no annotation); it is simply unguarded by tests.
- **Evidence:** `MUT [fallthrough when assigned name is not PascalCase]: *** SURVIVED ***`.

### 5. No plugin options: no opt-out, no ignore list, no `node_modules` guard

- **Where:** `packages/babel-plugin-component-annotate/src/index.ts:61` (the plugin factory takes only
  `babel`, never an options argument)
- **What:** The plugin is unconfigurable. There is no way to exclude a component, a file, or a directory,
  and it performs **no filename check** — a file under `node_modules` is annotated identically to first-party
  source. Skipping dependencies is delegated entirely to the host build config's `exclude`.
- **Why it matters (privacy/payload, mandate item 3):** I verified the intent and **production emission is
  deliberate, not a leak** — `docs/design/component-tree-capture.md:73-78` explicitly relies on the
  annotation surviving into production ("It already works in production for all five frameworks… The build
  plugins emit literal component names → un-minified"), and `docs/design/frontend-adapters.md:329` calls it
  "production-safe". So there is no dev-only policy being violated. The residual concern is that component
  names are permanently embedded in shipped DOM with **no escape hatch**: a codebase with names like
  `AdminSalaryOverride` or `InternalFraudScorePanel` ships them to every visitor, and the only remedy today
  is to remove the plugin wholesale. The structural peer `@bugsee/svelte-plugin-component-annotate` does take
  an options object (`ComponentAnnotateOptions`), and Sentry's equivalent plugin exposes an ignore list.
- **Evidence:** `transformSync(..., { filename: '/app/node_modules/some-lib/dist/Button.jsx' })` → 2
  annotations emitted; no options parameter exists anywhere in the 100-LOC source.

### 6. TypeScript is completely untested, and a syntax-only TS pipeline loses annotations

- **Where:** `packages/babel-plugin-component-annotate/src/index.test.ts:1-12` (the harness loads only
  `@babel/plugin-syntax-jsx`; no `.tsx` case exists in the file)
- **What:** Every test input is plain JS. `.tsx` — the dominant real-world case — has zero coverage. I
  verified the behaviour manually: **with `@babel/preset-typescript` everything works** (`as`, `satisfies`,
  `const Foo: FC = …`, `const Foo = <T,>(p: T) => …` all annotate correctly, because the preset strips the
  wrapper node before this plugin's visitor reaches the function). **Without the TS transform** (a
  parse-only `@babel/plugin-syntax-typescript` pipeline, e.g. when types are handled by tsc/esbuild and babel
  only annotates), `const Foo = (() => <div/>) as FC` and the `satisfies` form yield **0 annotations**,
  because the arrow's parent is a `TSAsExpression`/`TSSatisfiesExpression` that `assignedVariableName`
  (`index.ts:35`) does not unwrap.
- **Why it matters:** A config-dependent silent gap in the primary target language, with nothing in the
  tests or README to flag it.
- **Evidence:** syntax-only TS → `const Foo = (() => <div />) as FC;` (0 annotations); with
  preset-typescript → `const Foo = () => <div data-bugsee-component="Foo" />;` (1).

### 7. No integration test against a real JSX transform

- **Where:** `packages/babel-plugin-component-annotate/src/index.test.ts:6-11`
- **What:** The suite only ever pairs the plugin with `@babel/plugin-syntax-jsx`, so it asserts on
  **JSX-shaped output strings**. Nothing verifies the plugin still works once `@babel/preset-react` actually
  compiles the JSX away — the single most important integration property (if the JSX transform ran first,
  this plugin would be a silent no-op). Per the repo's own standard #3 (integration tests at every
  cross-package boundary), this boundary is untested.
- **Why it matters:** A visitor-ordering regression — or a Babel version that moves the JSX transform to an
  earlier phase — would silently disable the entire feature with a fully green suite.
- **Evidence:** I ran the missing integration myself and the plugin **passes**: preset-react `automatic` → 2
  annotations inside `_jsx("div", { className: "c", "data-bugsee-component": "UserCard", … })`;
  preset-react `classic` → 2; `preset-env(ie11)` + preset-react → 2; and both orderings of the raw
  `@babel/plugin-transform-react-jsx` plugin → 2. Correct today, unguarded tomorrow.

### 8. Missing `api.assertVersion()` (Babel hygiene)

- **Where:** `packages/babel-plugin-component-annotate/src/index.ts:61`
- **What:** The plugin accepts `babel: { types }` and never calls `api.assertVersion(7)`, the standard guard
  every first-party Babel plugin uses to produce a clear error on a version mismatch instead of an obscure
  downstream crash. `peerDependencies` correctly declares `@babel/core: ^7` (`package.json:33-35`) and
  `@babel/core` is correctly a dev/peer dep only — never a runtime dependency — so this is hygiene, not a
  packaging defect. Repo-wide there are zero `assertVersion` usages, so this is consistent, not an outlier.
- **Why it matters:** Under Babel 8 the plugin would fail late and unclearly rather than early and clearly.
- **Evidence:** `grep -rn 'assertVersion' packages/ --include='*.ts'` → no matches.

### 9. README drift: "Vue/Svelte Vite plugins are a follow-up"

- **Where:** `packages/babel-plugin-component-annotate/README.md:20-21`
- **What:** Both counterparts are built and on `main` — `@bugsee/svelte-plugin-component-annotate` (a Svelte
  preprocessor) and the Vue mixin `createBugseeVueComponentMixin` (`packages/vue/src/component-annotate.ts`).
- **Why it matters:** Docs-only, but it steers a reader toward believing non-JSX frameworks are unsupported.
- **Evidence:** Both packages exist with full implementations and tests.

### 10. Equivalent mutant (recorded so it is not re-litigated)

- **Where:** `packages/babel-plugin-component-annotate/src/index.ts:56`
- **What:** Removing the `attr.name.type === 'JSXIdentifier'` guard in `hasAttribute` survives the suite, but
  I verified it is **behaviourally equivalent**, not a test gap: for a `JSXNamespacedName`, `attr.name.name`
  is an AST node, never a string, so the `=== ATTRIBUTE` comparison is false either way. The guard is
  correct defensive typing. `<div ns:data-bugsee-component="X"/>` correctly still receives its own
  annotation (a namespaced attribute is a different attribute).
- **Why it matters:** No action needed; documented to prevent a future reviewer filing it as a gap.

---

## Untested JSX constructs

Confirmed absent from `src/index.test.ts` (behaviour verified manually by me; all correct unless noted):

| Construct | Actual behaviour (verified) |
|---|---|
| Fragments `<>…</>` | Inner host elements annotated, fragment itself untouched — correct |
| Namespaced elements `<svg:circle/>` | Skipped (not annotated) |
| Custom elements `<my-widget/>` | Annotated (lowercase → host) |
| Spread attributes `<div {...props}/>` | Annotated, appended last (see SEV3-2/3) |
| Existing annotation as an **expression** `data-bugsee-component={x}` | Skipped — only the string-literal form is tested |
| Ternary / conditional JSX | Both branches annotated |
| Truly **nested** component definitions | Correct (innermost wins) — but see SEV3-1 |
| Class property arrows (`render = () => <div/>`) | Annotated with the class name |
| Class getters | Annotated with the class name |
| Object-property arrows (`{ Bar: () => <div/> }`) | Not annotated |
| Anonymous default exports (`export default () => …`, `export default function(){}`) | Not annotated (README-documented limit, untested) |
| `memo(forwardRef(...))` double wrap | Not annotated (README-documented limit, untested) |
| `let`-assigned / bare reassignment (`Foo = () => …`) | `let` annotated; bare assignment not |
| Non-component call wraps (`const Items = list.map(i => <li/>)`) | **False positive** — annotates `"Items"` |
| Hook wraps (`const Rows = useMemo(() => <div/>, [])`) | Annotates `"Rows"` |
| JSX in default parameter positions | Annotated with the enclosing component |
| Files with no JSX at all | No-op |
| `.tsx` / TypeScript (`as`, `satisfies`, generics, typed consts) | See SEV3-6 |
| `node_modules` / third-party files | Annotated — no filename guard (SEV3-5) |
| Real JSX transform (preset-react / preset-env) | Works — but untested (SEV3-7) |

---

## Checked and found clean

- **Producer/consumer contract matches byte-for-byte.** The plugin emits `ATTRIBUTE = 'data-bugsee-component'`
  (`src/index.ts:11`) as a `t.stringLiteral` value; the runtime reader
  `packages/browser/src/component-name.ts:10` declares the identical
  `COMPONENT_ATTRIBUTE = 'data-bugsee-component'` and resolves it via
  `closest('[data-bugsee-component]') + getAttribute(...)` (`component-name.ts:22-23`), consumed by
  `interaction-source.ts:102` and `input-source.ts:87`. No drift. The Svelte sibling
  (`svelte-plugin-component-annotate/src/annotate.ts`) hardcodes the same literal. **Component attribution is
  wired correctly end-to-end.**
- **No AST corruption, in any of 31 constructs.** Every transform produced valid, re-parseable JSX. No
  dropped attributes, no reordered user attributes (the annotation is only ever appended), no invalid nodes.
  Attributes are built with `t.jsxAttribute`/`t.jsxIdentifier`/`t.stringLiteral` — proper builders, never
  raw object literals (`src/index.ts:92-94`).
- **Idempotent / no visitor re-entrancy loop.** The injected node is pushed directly onto `node.attributes`
  (not via a path API), so Babel does not requeue it; even if it did, `hasAttribute` (`index.ts:91`) short-
  circuits. Re-running the plugin over already-annotated output adds nothing. No infinite loop.
- **Source-map fidelity is preserved** (important: SDK symbolication depends on it). Decoded and compared
  VLQ mappings for annotated vs. baseline output of a multi-line component: **38 mappings in both**,
  identical generated line count (6/6), and every original token (`UserCard`, `className`, `onClick`,
  `boom`, `go`, `</button>`) maps back to its exact original line:column. The injected attribute carries no
  `loc` and inherits the enclosing tag's position; it does not shift or invalidate neighbouring mappings.
- **Fragments, member expressions and namespaced elements are all correctly skipped** — `<Foo.Bar/>` and
  `<svg:circle/>` are guarded by the `name.type !== 'JSXIdentifier'` check (`index.ts:90`), and
  `JSXOpeningFragment` is a different node type that the visitor never matches. Removing that guard is caught
  by the suite.
- **Component elements are never annotated** (`isHostTag`, `index.ts:13`) — correct, since the attribute
  would silently become a React prop rather than a DOM attribute.
- **Concurrency claim holds.** The `index.ts:63-64` comment asserting a single shared closure is safe is
  correct for concurrent builds: 40 files through concurrent `transformAsync` on one shared instance → 0
  cross-file annotation leaks. (Nesting is the exception — SEV2-1.)
- **Per-file scope reset and stack popping are genuinely tested**, including the hard case of a file that
  throws mid-traversal (`index.test.ts:85-119`); both corresponding mutations are caught.
- **Packaging is correct.** `@babel/core` is a peer + dev dependency only, never a runtime dep
  (`package.json:33-38`); `sideEffects: false`; dual ESM/CJS via `publishConfig`. `private: true` is
  repo-wide (53/53 packages), so it is pre-release state, not a packaging defect. `dist/` is gitignored.
- **Gates pass:** `tsc --noEmit` clean; 14/14 tests pass; coverage **100% statements / 100% branches /
  100% functions / 100% lines** — the numeric gate is met (the caveat is mutation strength, above).
- **No feature stub / dead code**; no `node_modules` write path; the plugin never imports `@bugsee/*` at
  runtime, keeping it a pure build tool.

---

### Repo hygiene

`git status --short packages/babel-plugin-component-annotate` → **empty**; `git diff --stat` → empty. All
mutations were applied from a backup copy and fully reverted; all probes ran from the scratchpad.
