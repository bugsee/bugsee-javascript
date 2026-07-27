# Adversarial review — @bugsee/svelte-plugin-component-annotate

**Reviewed:** 2026-07-26 · **Scope:** packages/svelte-plugin-component-annotate (impl 217 LOC across 4 files, tests 316 LOC across 4 files)
**Verdict:** The transform itself is **sound and does not corrupt user builds**. It is parser-based (not regex), so `<script>`/`<style>`/`{@html}` are structurally out of reach; insertions are applied highest-offset-first, which I verified is load-bearing (an ascending-order mutation is caught). Over a realistic multi-construct component the output preserved the element set and order, annotated every host element exactly once, preserved the line count and `<textarea>` content, compiled cleanly under `svelte/compiler`, and was idempotent on a second pass. The Babel sibling's shared-state defect has **no analogue here — verified safe** (no module-level mutable state; interleaved and nested re-entrant calls produce identical, correct results). Coverage is a genuine 100/100/100/100 with 37 passing tests, and 23 of 26 targeted mutations were caught. The real problems are at the edges the tests never touch: (1) a **bare `catch` turns any parse failure into a silent whole-file no-op**, which — combined with the wiring the README documents — silently disables component attribution for TypeScript components on the declared Svelte 4 floor and for `<style lang="scss">`/`stylus` on *every* version, with no diagnostic; (2) **neither hook returns a `map`**, and with `renderSpans: true` this measurably destroys symbolication — the user's instance-script lines end up with zero mappings and 30/30 markup-line segments point at the wrong original text; (3) there is **no `node_modules` guard and no opt-out of any kind**, so third-party library components are annotated with their own basenames. Nothing in the repo wires this preprocessor, so none of it is covered by an e2e.

## SEV1

### 1. A parse failure silently disables annotation for the whole file — hit by TypeScript on Svelte 4 and by SCSS/Stylus on every version

- **Where:** `packages/svelte-plugin-component-annotate/src/annotate.ts:79-83` (the bare `catch { return undefined; }`), reached from `packages/svelte-plugin-component-annotate/src/index.ts:41`; wiring documented at `packages/svelte-plugin-component-annotate/README.md:16`; peer floor at `packages/svelte-plugin-component-annotate/package.json:27`.
- **What:** `annotateMarkup` calls the injected `parse` inside a `try`, and *any* throw returns `undefined`, which `index.ts:42` turns into "leave the file untouched". The comment at `annotate.ts:8` and `README.md:33` justify this as "a genuine syntax error — defer to Svelte's own compiler for the diagnostic". That reasoning only holds when the throw really is a user syntax error. It is not, in two common cases, because **`svelte.parse` also parses the `<script>` and `<style>` bodies**, and preprocessor groups run in array order — so with the README's documented wiring this hook sees the *unconverted* TS/SCSS:
  - **Svelte 4 + `<script lang="ts">`** — Svelte 4's parser has no TypeScript support, so it throws. `package.json:27` declares `"svelte": ">=4"`, so Svelte 4 is a supported target.
  - **Any Svelte version + `<style lang="scss">` / `lang="stylus">`** — Svelte's CSS parser rejects SCSS variables and Stylus indentation syntax.
- **Why it matters:** The user gets **zero annotations for the entire component**, forever, with no warning, no log line and no build error — the failure is indistinguishable from "the plugin is installed and working". Every downstream consumer degrades silently: `ui.component` is absent from interaction and input entries (`packages/browser/src/interaction-source.ts:102`, `packages/browser/src/input-source.ts:87`), and the planned component-tree overlay (`docs/design/component-tree-capture.md:124`) has nothing to read. TypeScript is the majority configuration for Svelte projects and SCSS is the most common style dialect, so this plausibly disables the feature for most real apps that follow the README. Note the breakage is *construct-dependent*, which makes it worse to diagnose: plain SCSS nesting parses fine while SCSS **variables** do not, so the feature appears to work in some components and not others.
- **Evidence:** Ran the real preprocessor (Svelte 5.56.3) and a faithful mirror of `annotate.ts`'s walker against a locally extracted `svelte@4.2.19` (`compiler.cjs`):

  | input | Svelte 4.2.19 | Svelte 5.56.3 |
  |---|---|---|
  | `<script lang="ts">let n: number = 0;</script><div>{n}</div>` | `PARSE THREW: Unexpected token` → **no-op** | annotated |
  | `<script lang="ts">interface Q { a: string }</script>` | `PARSE THREW: The keyword 'interface' is reserved` → **no-op** | annotated |
  | `<script context="module" lang="ts">export const x: number = 1;</script>` | `PARSE THREW` → **no-op** | annotated |
  | `<style lang="scss">$c: red; .a{color:$c}</style>` | `PARSE THREW: Selector is expected` → **no-op** | **no-op** |
  | `<style lang="stylus">…</style>` | — | **no-op** |
  | `<style lang="scss">.a { .b { color: red; } }</style>` (nesting only) | — | annotated |
  | `<style>.a{color:red}</style>` (control) | annotated | annotated |

  Ordering is the rescue, and it is not documented. Driving the real `svelte.preprocess()` with a stand-in `vitePreprocess`-style group:
  ```
  [ours, langPreprocess]  (README order) annotated: false
  [langPreprocess, ours]  (fixed order)  annotated: true
  ```
  `README.md:16` shows `preprocess: [componentAnnotatePreprocessor()]` — alone, and therefore first — which is the failing order once the user adds `vitePreprocess()`/`svelte-preprocess` (as every TS or SCSS project must).

## SEV2

### 2. Neither hook returns a `map`; with `renderSpans: true` this destroys the component's source mappings

- **Where:** `packages/svelte-plugin-component-annotate/src/index.ts:42` (`return code === undefined ? undefined : { code };`) and `packages/svelte-plugin-component-annotate/src/render-span-inject.ts:41` (`return { code: injection + input.content };`).
- **What:** Svelte's preprocessor contract is `{ code, map?, dependencies?, attributes? }`. When a hook returns no `map`, Svelte does **not** synthesise an identity map — `MappedCode.from_processed` (`node_modules/.pnpm/svelte@5.56.3_.../node_modules/svelte/src/compiler/utils/mapped_code.js:192-208`) pushes an **empty** `SourceMapSegment[]` for every line, i.e. the region becomes unmapped. Two distinct consequences:
  - **markup hook:** insertions are inline, so line numbers survive, but every column after the tag name on that line shifts right by `len(' data-bugsee-component="Name"')`. `preprocess()` returns `map: null`.
  - **`script` hook (`renderSpans: true`):** the injection prepends **3 lines** ahead of the user's code with no map to describe the shift, so the user's entire instance script becomes unmapped.
- **Why it matters:** This is the SDK's own core value proposition — symbolicated stack traces — being degraded by the SDK's own build tool. A runtime error thrown inside a component's `<script>` cannot be mapped back to its original `.svelte` line. It also silently undermines the `#158` debug-ID / source-map tooling, which assumes the emitted chain is faithful. `README.md:34` states "Insertions are inline on the tag line, so source line numbers are preserved" — true for the markup hook, but the README says nothing about the script hook's +3-line shift or about the absent `map`.
- **Evidence:** Real `svelte.preprocess()` + `svelte.compile()` on a 6-line component.
  - Default (markup only): `preprocess().map = null`. Compiled JS line 11 `function boom() {` → segments `[[1,0,2,2],…]` → maps to `Probe.svelte` line 2 — **correct at line level** (the markup change did not move lines).
  - `renderSpans: true`: `preprocess().map` is present but hollow —
    ```
    out  0 "<script>import { onMount as __bugsee_onMount…"  segs=[[0,0,0,0],[1,0,0,1],[7,0,0,7]]
    out  4 "  let a = 1;"                                    segs=[]
    out  5 "  function boom() { throw new Error(\"x\"); }"   segs=[]
    out  6 "</script>"                                       segs=[[0,0,3,0],…]
    ```
    Compiled JS line 14 `function boom() {` → segments `[]` → **NO SOURCE MAPPING for the user function (symbolication lost)**.
  - Column drift on the markup line, same run (`<div class="wrapper" id="root">t</div>`, 30 chars inserted): **30/30 segments map to the wrong original text**, e.g. `outCol 26 "=\"W\" cla" -> src 4:26 "oot\">t</"`, `outCol 31 "class=\"w" -> src 4:31 "t</div>"`, and everything past `outCol 38` maps past the end of the original line.

### 3. No `node_modules` guard and no opt-out — third-party components are annotated and mis-attributed

- **Where:** `packages/svelte-plugin-component-annotate/src/component-name.ts:9-23` (the only filter is `.endsWith('.svelte')`) and `packages/svelte-plugin-component-annotate/src/index.ts:25-29` (`ComponentAnnotateOptions` exposes `renderSpans` and nothing else).
- **What:** There is no path filtering anywhere in the package, no `include`/`exclude`, no `enabled` flag, and no environment gate. Every `.svelte` file the bundler routes through `preprocess` is annotated, including library components shipped as `.svelte` source under `node_modules`.
- **Why it matters:** Two consequences. (a) **Attribution correctness:** `componentNameFromElement` resolves the *nearest* annotated ancestor (`packages/browser/src/component-name.ts:22`), so a click on a control rendered by a third-party library reports the **library's** internal component name (`Button`, `Modal`) instead of the customer's own enclosing component — the innermost annotation always wins. (b) **Payload/privacy:** annotations ship to end users unconditionally; on my realistic probe component the transform added **406 bytes for 14 annotations** (~29 bytes each), and the component names of both the app and its dependencies become publicly visible in the DOM. There is no escape hatch short of removing the preprocessor.
- **Evidence:**
  ```
  /app/node_modules/some-ui-lib/dist/Button.svelte -> <button data-bugsee-component="Button">x</button>
  /app/node_modules/@scope/kit/src/Modal.svelte    -> <button data-bugsee-component="Modal">x</button>
  /app/src/lib/Mine.svelte                         -> <button data-bugsee-component="Mine">x</button>
  ```
  `NODE_ENV=production` → still annotates (`<div data-bugsee-component="P">x</div>`). Accepted option keys: `['renderSpans']`.
  **Not drift:** the Babel sibling has no env gating either (`grep -n 'NODE_ENV|production' packages/babel-plugin-component-annotate/src/index.ts` → no matches), and neither README claims a dev-only intent. The gap is the absence of an opt-out, not an inconsistency between the two.

## SEV3

### 4. `<svelte:element>` is annotated under the legacy AST but not under the modern AST

- **Where:** `packages/svelte-plugin-component-annotate/src/annotate.ts:16` (`ELEMENT_TYPES = new Set(['Element', 'RegularElement'])`).
- **What:** Svelte's legacy AST types `<svelte:element>` as `Element` (name `svelte:element`), so it matches `ELEMENT_TYPES` and `isHostTag`. The modern AST types it as `SvelteElement`, which matches neither. Since `index.ts:41` calls `parse(source, { filename })` without `modern: true`, Svelte 5 returns the legacy AST today and `<svelte:element>` **is** annotated; the moment the modern AST becomes the default (Svelte 6, per the comment at `annotate.ts:4-5`) it silently stops being annotated.
- **Why it matters:** Not a corruption — the annotated output compiles cleanly and `svelte:element` forwards attributes to the rendered element — but it is an undetected behavioural regression waiting on a Svelte major, in a package whose header explicitly claims to be version-agnostic. No test covers `<svelte:element>` on either path.
- **Evidence:** `annotateMarkup('<svelte:element this={tag}>x</svelte:element>', 'N', parse)` → legacy `[<svelte:element]`, modern `[<none>]` — the only divergence across 9 constructs I compared. Node types dumped from both parsers: legacy `svelte:element:Element` vs modern `svelte:element:SvelteElement`. Annotated output compiles OK (`compile()` succeeded for both `this={tag}` and `this={'br'}`).

### 5. `<svelte:head>` children are annotated — pure payload, zero attribution value

- **Where:** `packages/svelte-plugin-component-annotate/src/annotate.ts:53-65` — the walker descends into every key without excluding head content.
- **What:** `<meta>`, `<link>` and other `Element` nodes inside `<svelte:head>` receive the attribute. (`<title>` escapes only incidentally, because Svelte types it `Title`/`TitleElement`.)
- **Why it matters:** Head elements are never interaction targets and `closest()` never reaches them from a body node, so the annotation can never be read. It ships bytes into every page's `<head>` and pollutes SEO/meta tags with a Bugsee attribute.
- **Evidence:** `<svelte:head><title>t</title><meta name="a" content="b"></svelte:head>` → `<svelte:head><title>t</title><meta data-bugsee-component="Probe" name="a" content="b"></svelte:head>` — identical under legacy and modern ASTs.

### 6. Three surviving mutations — untested guards and an unasserted parameter

- **Where:** `packages/svelte-plugin-component-annotate/src/annotate.ts:45`, `packages/svelte-plugin-component-annotate/src/annotate.ts:29`, `packages/svelte-plugin-component-annotate/src/index.ts:41`.
- **What:** Despite 100% line/branch/function/statement coverage, three mutations pass the entire suite:
  - **M4** — deleting `(a as AnyNode).type === 'Attribute' &&` from `isAnnotated` (`annotate.ts:45`). No test supplies a non-`Attribute` node named `data-bugsee-component`, so the type discriminator is unverified.
  - **M5** — deleting `typeof node.name !== 'string' ||` from `asHostElement` (`annotate.ts:29`). Untested, and *not* inert: with it gone, an `Element` node whose `name` is `undefined` passes `isHostTag` (`/^[a-z]/.test(undefined)` tests the string `"undefined"` → `true`), gets pushed, and then throws `TypeError` at `e.name.length` (`annotate.ts:95`) — i.e. the guard is the only thing standing between a malformed node and a **thrown markup hook that fails the user's build**.
  - **M24** — dropping `{ filename }` from `parse(source, { filename })` (`index.ts:41`). Nothing asserts the filename is forwarded; it only feeds Svelte's parse-error message, which `annotate.ts:81` discards anyway.
- **Why it matters:** Coverage is being satisfied without the assertions that would catch a regression in these three places. M5 in particular guards a build-breaking failure mode.
- **Evidence:** 26 targeted mutations run through `vitest run` with full restore between each. Three **control** mutations that must be caught were caught, proving the harness works: `isHostTag` accepting PascalCase (1 failed), insertion offset off-by-one (8 failed), `escapeAttr` not escaping quotes (1 failed). 23/26 real mutations caught — notably the descending-splice order (`M1` ascending → 1 failed; `M2` no sort → 1 failed), the already-annotated guard (`M3`), `RegularElement` removal (`M7`), both AST roots (`M8`/`M9`), the cycle guard (`M10`), and every `render-span-inject` and `component-name` guard. `git status --short` verified empty after the run.

### 7. Test suite never drives the real preprocessor API, the source map, or the cross-package attribute contract

- **Where:** `packages/svelte-plugin-component-annotate/src/index.test.ts:1-58`, `packages/svelte-plugin-component-annotate/src/annotate.test.ts:1-142`.
- **What:** Three structural gaps.
  - **No test calls `svelte.preprocess()`.** `index.test.ts` invokes `pre.markup(...)`/`pre.script(...)` directly, so the actual preprocessor contract — that Svelte accepts this object shape, that returning `undefined` is legal, that the hooks compose with other groups — is never exercised. (I verified assignability separately: `tsc --strict` accepts `const g: PreprocessorGroup = componentAnnotatePreprocessor()` and the array form, exit 0. The contract holds; it is just untested.)
  - **No source-map test at all** — which is why SEV2 went unnoticed.
  - **No test pins the emitted attribute against the runtime reader.** `ATTRIBUTE` (`annotate.ts:12`) is a hand-copied literal whose only link to `COMPONENT_ATTRIBUTE` (`packages/browser/src/component-name.ts:10`) is the comment at `annotate.ts:10-11`. A rename on either side compiles, typechecks and passes both suites while silently killing attribution. The package deliberately has no `@bugsee` dependency, but a test asserting the literal string would still catch it.
  - Additionally, `annotate.test.ts` exercises the walker almost entirely through **hand-built fake ASTs** (`legacyParse`/`modernParse`, `annotate.test.ts:9-18`). That is a legitimate choice for unit isolation, but it means the fakes, not Svelte, define what the walker is tested against — and the real-parser suite that would validate the fakes is only 6 tests.
- **Why it matters:** The suite is not theatre — every test asserts a concrete output string and 23/26 mutations die — but its *shape* leaves the highest-blast-radius surfaces (real preprocessor integration, source maps, the producer/consumer contract) entirely unguarded.
- **Evidence:** `vitest run --coverage` → 37 tests, 4 files, `Statements 100% (79/79) · Branches 100% (57/57) · Functions 100% (16/16) · Lines 100% (60/60)`. Grep for `preprocess(` in the package's tests → no matches. Grep for `map` in the package's tests → no matches.

### 8. Nothing in the repository wires this preprocessor

- **Where:** `packages/sveltekit-e2e/svelte.config.js` (declares only `kit: { adapter: adapter() }`).
- **What:** `grep -rn 'svelte-plugin-component-annotate|componentAnnotatePreprocessor'` across the repo returns only its own package, two design docs, the Babel review, and a comment in `packages/svelte/src/render-span.ts:4`. `@bugsee/svelte`, `@bugsee/sveltekit` and the SvelteKit e2e app do not use it.
- **Why it matters:** There is no end-to-end proof that an attribute emitted by this plugin is actually read by `componentNameFromElement` in a running app — the two halves of the D2/D3 mechanism are only ever tested in isolation. The existing `sveltekit-e2e` app is the natural place to close this.
- **Evidence:** Full-repo grep above; `cat packages/sveltekit-e2e/svelte.config.js`.

### 9. Minor documentation drift in the runtime reader

- **Where:** `packages/browser/src/component-name.ts:1-6`.
- **What:** The header comment attributes the emit side solely to "`@bugsee/babel-plugin-component-annotate`, D3", with no mention of this Svelte preprocessor or the Vue mixin (`packages/vue/src/component-annotate.ts`), even though all three feed the same reader.
- **Why it matters:** Cosmetic, but it is the one place a reader looks to discover who produces the attribute.
- **Evidence:** Comment text at `packages/browser/src/component-name.ts:2-3`.

## Untested Svelte constructs

Verified against the two test files. Each of the following is **handled correctly** (I confirmed the behaviour empirically through the real `svelte/compiler`), but **no test covers it**:

| Construct | Actual behaviour (verified) | Test coverage |
|---|---|---|
| `{#each}` / `{#await}` / `{:then}` / `{:catch}` / `{#key}` | children annotated | none (only `{#if}` via a fake `IfBlock`, and one real-parse `{#if}`) |
| `{:else}` branch | annotated | none |
| `{@const}` / `{@debug}` | inert, siblings annotated | none |
| `{@html '<div>x</div>'}` | correctly **not** annotated (string, not markup) | none |
| `{#snippet}` / `{@render}` (Svelte 5) | snippet body annotated with the *defining* file's name | none |
| Runes (`$state`, `onclick={…}`) | annotated normally | none |
| `<slot>` / named slots | `<slot>` itself correctly skipped (`Slot`/`SlotElement`); fallback content annotated | none |
| `<svelte:fragment slot="…">` | correctly skipped (`SlotTemplate`); children annotated | none |
| `<svelte:self>` / `<svelte:component>` | correctly skipped (`InlineComponent`) | none |
| `<svelte:window>` / `<svelte:body>` / `<svelte:document>` / `<svelte:head>` / `<svelte:options>` | correctly skipped (`Window`/`Body`/`Document`/`Head`/`Options`) | none |
| `<svelte:boundary>` (Svelte 5) | correctly skipped; children annotated | none |
| **`<svelte:element>`** | **annotated (legacy) / skipped (modern)** — see SEV3 #4 | none |
| `<meta>` inside `<svelte:head>` | annotated — see SEV3 #5 | none |
| Spread props `<div {...rest}>` | attribute inserted **before** the spread, so a spread key of the same name would win at runtime | none |
| Shorthand attributes `<input {value} />` | annotated correctly | none |
| Template-expression attributes `class="a {b}"` | annotated correctly | none |
| Void elements (`<br>`, `<hr>`, `<img>`, `<input>`) | annotated correctly | one fake-AST `<hr>` case (for the missing-`attributes` guard, not for void semantics) |
| Self-closing `<div />` | annotated correctly | none |
| Multi-line opening tags | annotated on the tag line; line count preserved | none |
| `<textarea>` / `<pre>` (whitespace-sensitive) | content untouched | none |
| Custom elements (`<my-widget>`) | annotated | none |
| `<style>` block containing element selectors (`div > p`) | untouched | none (only a `<script>`-untouched assertion) |
| `<script lang="ts">` | works on Svelte 5, **fails on Svelte 4** — see SEV1 | none for the markup hook (only the `script` hook has a `lang: 'ts'` case) |
| `<style lang="scss">` / `stylus` | **whole-file no-op** — see SEV1 | none |
| CRLF line endings | handled correctly | none |
| Astral-plane characters before an element | offsets correct (UTF-16 code units) | none |
| Empty file / script-only file | correctly returns `undefined` | script-only covered; empty file not |
| Idempotency through the **real** parser | correctly returns `undefined` on a second pass | only via a fake AST |
| Nested `<script>`/`<style>` inside markup | annotated (harmless) | none |

## Cross-plugin contract check

**Result: the contract matches byte-for-byte across all three points. Confirmed.**

- **Svelte emit** — `packages/svelte-plugin-component-annotate/src/annotate.ts:12`: `const ATTRIBUTE = 'data-bugsee-component';`, spliced at `annotate.ts:93` as `` ` ${ATTRIBUTE}="${escapeAttr(componentName)}"` ``.
- **Babel emit** — `packages/babel-plugin-component-annotate/src/index.ts:11`: `const ATTRIBUTE = 'data-bugsee-component';`.
- **Runtime read** — `packages/browser/src/component-name.ts:10`: `export const COMPONENT_ATTRIBUTE = 'data-bugsee-component';`, resolved at `component-name.ts:22-23` via `el.closest('[data-bugsee-component]')` + `getAttribute('data-bugsee-component')`.

All three literals are identical. Consumers of the reader (`packages/browser/src/interaction-source.ts:102`, `packages/browser/src/input-source.ts:87`, surfaced as `ui.component` per `packages/performance/src/interactions.ts:38`) are attribute-name-agnostic and go through `COMPONENT_ATTRIBUTE`.

**Value format agrees.** Both emitters write the bare component name as a double-quoted attribute value. The Svelte side additionally HTML-escapes `&`, `"` and `<` (`annotate.ts:67-68`) — the browser un-escapes these during HTML parsing, so `getAttribute` returns the original string; verified `annotateMarkup(…, 'A"&<B', …)` → `data-bugsee-component="A&quot;&amp;&lt;B"`. The reader rejects empty values (`typeof name === 'string' && name !== ''`, `component-name.ts:23`) and the Svelte side can never emit one, since `componentNameFromFilename` returns `undefined` for an empty result (`component-name.ts:22`) and `index.ts:40` then skips the file.

**Naming-semantics difference (by design, not a defect).** Babel names by the *enclosing PascalCase function/class*; Svelte names by the *file* (basename, or the parent directory for `index.svelte` and SvelteKit `+page`/`+layout`/`+error`). This is correct — a Svelte component **is** its file — and both produce a stable, minification-surviving literal, which is the property the reader depends on.

**Unenforced.** The agreement rests on three hand-copied literals and a comment (`annotate.ts:10-11`); no test asserts it. See SEV3 #7.

## Checked and found clean

- **Shared/module-level state — the Babel sibling's defect has no analogue here. Verified safe, with the reason.** The only module-level bindings are immutable constants: `ATTRIBUTE` (`annotate.ts:12`), `ELEMENT_TYPES` (`annotate.ts:16`), `ONMOUNT_ALIAS`/`RENDER_ALIAS` (`render-span-inject.ts:15-16`). The walker's accumulators are **parameters**, freshly allocated per call at `annotate.ts:89-90` (`const elements: HostElement[] = []; collectHostElements(markup, elements, new Set());`), and `componentAnnotatePreprocessor` builds a fresh `group` object per invocation (`index.ts:37`). There is therefore no state for a concurrent, parallel or re-entrant call to clobber. Empirically confirmed: interleaving `/A.svelte` → `/B.svelte` → `/A.svelte` produced byte-identical results for A both times, and invoking `pre.markup()` for a *different* file from **inside** the `parse` callback of an in-flight `annotateMarkup` left the outer result fully correct (`<div data-bugsee-component="Outer"><i data-bugsee-component="Outer">x</i></div>`).
- **Markup-only scoping genuinely holds — the implementation is parser-based, not regex-based.** `annotate.ts:87` roots the walk at `ast.fragment ?? ast.html`; Svelte places `<script>`, `<script context="module">` and the top-level `<style>` on the *sibling* `instance`/`module`/`css` properties, which are never reached. Stress-tested: a `<script>` containing the literal string `"<div>not markup</div>"` was untouched; a `<style>` containing `div.foo > span { color: red }` was untouched while the real `<div>`/`<span>` in the markup were annotated.
- **Descending-splice offset math.** `annotate.ts:95` sorts insertion offsets highest-first so earlier offsets stay valid. Verified load-bearing by mutation: ascending order and no-sort are both caught.
- **Output round-trip over a realistic multi-construct component** (TS script, `svelte:head`, `svelte:window`, spread, `{#if}/{:else}`, `{#each}` keyed, `{#await}/{:then}/{:catch}`, `{#key}`, `svelte:element`, a child component with a slot, `<slot>`, `<textarea>`, `<input>`, `{@html}`, `<style>`): element set and order unchanged; **zero** host elements left un-annotated; line count preserved; `<textarea>` content, `{@html}`, `<style>` and `<script>` bodies all byte-identical; annotated output **compiles** under `svelte/compiler`; second pass returns `undefined` (idempotent). Component name correctly derived as `shop` from `/src/routes/shop/+page.svelte`.
- **No invalid markup emitted.** Every annotated output I produced compiled cleanly, including `<svelte:element>`, void elements, self-closing tags, spreads, shorthand attributes, snippets, runes, custom elements and slot fallbacks. Attribute insertion happens immediately after the tag name, so existing attributes keep their relative order and only shift right.
- **Idempotency / re-entrancy.** `isAnnotated` (`annotate.ts:38-49`) matches any `Attribute` named `data-bugsee-component`, including the expression form — `<div data-bugsee-component={x}>` is correctly left alone, as is a hand-written `<div data-bugsee-component="Manual">`. Re-running the hook over its own output is a no-op.
- **Preprocessor-API shape.** `{ markup, script? }` is structurally valid; `tsc --strict` accepts assignment to Svelte's own `PreprocessorGroup` both singly and as an array (exit 0). Returning `undefined` to mean "leave untouched" matches Svelte's `Processed | void` signature. `svelte` is correctly a `peerDependency` (`package.json:26-28`) with a `devDependency` for tests only (`package.json:29-31`) — no runtime dependency on `svelte` or on any `@bugsee` package.
- **`componentNameFromFilename`.** Handles POSIX and Windows separators, `index.svelte` and `+page`/`+layout`/`+error` directory fallback, the residual `+` strip, the empty-root-segment case, non-`.svelte` paths and `undefined`. Well covered (9 tests) and every guard I mutated was caught.
- **`injectRenderSpan` guards.** Module-script detection covers both Svelte 4 (`context: 'module'`) and Svelte 5 (`module` present) forms; the idempotency marker prevents double injection; `JSON.stringify(name)` correctly escapes exotic names. All four guards caught under mutation.
- **Escaping.** `escapeAttr` (`annotate.ts:67-68`) escapes `&`, `"` and `<` — sufficient for a double-quoted attribute value; `>` needs no escaping there.
- **Cyclic-AST safety.** The `seen` identity set (`annotate.ts:55-56`) prevents infinite recursion; removing it is caught by the back-reference test.
- **Coverage gate.** 100% statements/branches/functions/lines against the package's declared thresholds (`vitest.config.ts:13`), and `tsc --noEmit` passes.
- **Working tree left untouched.** `git status --short packages/svelte-plugin-component-annotate` verified empty after every mutation round and at the end of the review. All probe files, the `svelte@4.2.19` extraction and the mutation harness live in the session scratchpad.
