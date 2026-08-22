// WebView injectable-bundle guard (slice 6, docs/design/webview-bridge.md D7/§9).
//
// Native ships @bugsee/webview as a SELF-CONTAINED IIFE single-string resource and injects it at document-start;
// the bundle defines the `BugseeWebView` global (the native bootstrap calls `BugseeWebView.launch`). This guard
// bundles the same entry with the SAME esbuild config the injectable target uses (browser platform, `node:*`
// external, minified, globalName) — an INDEPENDENT re-bundle (matching the edge X2 precedent), not the package's
// `tsup` output — and asserts the artifact is:
//   - self-contained AND node-free: the output imports NOTHING — every workspace dep is inlined into the
//     single string, and the only node usage (@bugsee/util's guarded `node:crypto` dynamic import) is dead
//     under platform:browser and tree-shaken out entirely, so a WebView needs no loader and no builtins,
//   - within a size budget (a regression catch — the bundle ships fixed in the native binary, so size matters),
//   - LOADABLE: it evaluates in a fresh isolate and exposes `BugseeWebView.launch`.
// NOTE: self-containment is read from esbuild's METAFILE, not by searching the minified source.
//
// It used to be a literal-substring check — `not.toContain('@bugsee/')` and `not.toContain('node:')` — chosen
// because an ESM-shaped regex would pass vacuously against an IIFE (esbuild lowers an external import to a
// minified require-helper CALL like `i("@bugsee/util")`, not to an `import"…"` statement). That reasoning was
// right about regexes and wrong about substrings: it cannot tell an IMPORT from a STRING THAT MERELY LOOKS
// LIKE ONE. `@bugsee/core`'s `isUserFrame` classifies stack frames by path and so contains the literals
// `'/@bugsee/'` and `'node:'`; the day it landed, this guard failed a bundle that was — and the metafile
// proves still is — perfectly self-contained. `edge-bundle.ts` had already learned the same lesson for node
// imports, for the same reason, and this now uses the same mechanism.
// The full handshake/entry/control protocol round-trips against a mock native receiver are slice 7.

import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { bundleEdgeEntry } from './edge-bundle';

const KB = 1024;
// Current real size is ~22 KB gzip / ~60 KB raw (core+capture+browser+protocol+util). 64 KB gzip is ~3x headroom
// — catches a gross regression (an un-minified build, a duplicate-bundled or heavy new dep) while leaving room
// for organic growth (the viewtree / performance streams in later slices), and the artifact size stays logged.
const GZIP_BUDGET = 64 * KB;
const RAW_BUDGET = 200 * KB;

const IIFE_ENTRY = fileURLToPath(new URL('../../webview/src/iife.ts', import.meta.url));

describe('slice 6 — @bugsee/webview injectable IIFE bundle guard', () => {
  it('bundles self-contained, node-free, and within the size budget', async () => {
    const bundle = await bundleEdgeEntry(IIFE_ENTRY, 'iife', 'BugseeWebView');

    // Self-contained AND node-free in one property: the artifact is a single string injected into a WebView
    // that has no module loader and no node builtins, so ANY surviving import of any kind — a workspace
    // package left external, a `node:*` builtin, a bare dependency — means it cannot run. The metafile lists
    // exactly those and nothing else, so this asserts the real property rather than a proxy for it.
    expect(bundle.externalImports).toEqual([]);

    console.info(
      `[webview iife] ${(bundle.bytes / KB).toFixed(1)} KB raw / ${(bundle.gzipBytes / KB).toFixed(1)} KB gzip`,
    );
    expect(bundle.bytes).toBeLessThan(RAW_BUDGET);
    expect(bundle.gzipBytes).toBeLessThan(GZIP_BUDGET);
  });

  it('evaluates in a fresh isolate and exposes BugseeWebView.launch (loadable artifact)', async () => {
    const { code } = await bundleEdgeEntry(IIFE_ENTRY, 'iife', 'BugseeWebView');
    // A minimal browser-ish sandbox: the SDK is runtime-portable (reaches globals lazily via globalThis casts),
    // so module-init only needs console + a self-referential globalThis. Booting launch() against a mock native
    // receiver is slice 7; here we only prove the bundle LOADS and publishes its global API.
    const sandbox: Record<string, unknown> = { console };
    sandbox.globalThis = sandbox;
    createContext(sandbox);
    runInContext(code, sandbox);

    const api = sandbox.BugseeWebView as { launch?: unknown; VERSION?: unknown };
    expect(typeof api.launch).toBe('function');
    expect(typeof api.VERSION).toBe('string');
  });
});
