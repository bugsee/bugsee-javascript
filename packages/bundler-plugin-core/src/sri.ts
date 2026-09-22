// SM-A7 — detect Subresource Integrity BEFORE stamping, because stamping after emit breaks it.
//
// `sourcemaps inject` appends the debug-id comment and the `_bugseeDebugIds` registration to every
// emitted `.js`. A build that computed SRI hashes during emit (`webpack-subresource-integrity`,
// Angular's `subresourceIntegrity: true`) has already written a hash of the PRE-stamp bytes into the
// HTML, so the browser refuses the script and the page runs nothing at all.
//
// Measured 2026-09-18 on webpack 5.111 + webpack-subresource-integrity, Chromium 151: before inject
// the app ran clean; after it, `window.__ran` was false and the console carried "Failed to find a
// valid digest in the 'integrity' attribute … The resource has been blocked." `index.html` was
// byte-identical; only the JS grew (114 → 472 bytes).
//
// So we look for it and refuse rather than shipping a broken page. Rewriting the hashes is not a
// safe alternative: `webpack-subresource-integrity` also embeds the lazy chunks' hashes in the
// runtime chunk (`__webpack_require__.sriHashes`), so patching the HTML alone would still break
// every dynamic import. See docs/design/source-maps.md and docs/review/cli-js-flows.md §7.
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

/** One `<script>` whose `integrity` pins a file in the build output. */
export interface SriProtectedScript {
  /** Absolute path of the HTML page carrying the attribute. */
  html: string;
  /** Absolute path of the script it pins. */
  script: string;
  /** The `integrity` value as written, quotes removed — e.g. `sha384-…`, possibly several. */
  integrity: string;
}

/** Directories the HTML walk never descends into — same reasoning as the `.map` delete walk. */
const NEVER_WALK = new Set(['node_modules', '.git', 'test', 'tests', '__tests__']);

/** Build output is shallow; an unbounded walk from a mis-resolved root could traverse a disk. */
const MAX_DEPTH = 6;

/**
 * Every `<script>` tag, captured with its attributes. Deliberately a regex and not a parser: this is
 * a guard, and the shapes that matter are the ones bundlers emit (minified, attributes in any order,
 * quoted or bare). A tag we fail to parse is a tag we do not flag, which is the pre-existing
 * behaviour — this can only ever be MORE cautious than shipping the page blind.
 */
const SCRIPT_TAG = /<script\b[^>]*>/gi;
// A `<link rel=modulepreload integrity>` pins a chunk just as hard: the preload fails the integrity
// check, poisons the module map, and the later `import()` of that chunk fails with it. Angular's
// builder and the Vite SRI plugins emit these alongside the entry `<script>`.
const PRELOAD_TAG = /<link\b[^>]*>/gi;
const PRELOADS_SCRIPT = /\brel\s*=\s*("|')?(modulepreload|preload)\1?/i;
// HTML comments are not markup. `<!-- <script src=app.js integrity=…> -->` used to refuse the build.
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// `[\s"'<]` and not `\b`: `\bintegrity` also matches `data-integrity`, and `\bsrc` matches
// `data-src` — attributes a framework uses for its own bookkeeping, which pin nothing.
const INTEGRITY_ATTR = /[\s"'<]integrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;
const SRC_ATTR = /[\s"'<]src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;
const HREF_ATTR = /[\s"'<]href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;

const unquote = (value: string): string =>
  (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1)
    : value;

/** A src we could stamp: same-origin, relative, and inside the output directory. */
const resolveLocalScript = (outDir: string, htmlDir: string, src: string): string | undefined => {
  // A URL with a scheme or protocol-relative host is somebody else's file (a CDN); its bytes are not
  // ours to change, so stamping cannot invalidate its hash.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) {
    return undefined;
  }
  // Browsers strip surrounding whitespace from a URL attribute, so `src=" main.js "` loads main.js.
  const withoutQuery = (src.split(/[?#]/)[0] ?? '').trim();
  if (withoutQuery === '') {
    return undefined;
  }
  const full = isAbsolute(withoutQuery)
    ? // A root-relative `/assets/app.js` is served from the output root.
      join(outDir, withoutQuery)
    : resolve(htmlDir, withoutQuery);
  // `outDir` is resolved by the caller, so both sides are absolute. The separator matters: without
  // it, `dist-2/main.js` counts as inside `dist`.
  const root = normalize(outDir);
  const rooted = root.endsWith(sep) ? root : root + sep;
  return normalize(full).startsWith(rooted) ? full : undefined;
};

const walkHtml = async (dir: string, depth = 0): Promise<string[]> => {
  if (depth > MAX_DEPTH) {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A missing or unreadable output directory is not this guard's error to raise: the CLI reports
    // it properly ("path does not exist"), and throwing here would replace that with a worse one.
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (NEVER_WALK.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      found.push(...(await walkHtml(full, depth + 1)));
    } else if (entry.isFile() && /\.x?html?$/i.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
};

/**
 * Scripts in `outDir`'s HTML whose `integrity` attribute pins a file we would stamp.
 *
 * Empty means stamping is safe as far as SRI is concerned. Never throws: a path problem is the CLI's
 * to report.
 */
export async function findSriProtectedScripts(outDirInput: string): Promise<SriProtectedScript[]> {
  // Resolved FIRST: a bundler hands us whatever the user configured, and Rollup passes `output.dir`
  // through verbatim (`'dist'`) while `output.file: 'bundle.js'` resolves to `'.'`. Comparing an
  // absolute resolved script path against a relative root made every `src="main.js"` look like it
  // was outside the output directory, so the guard was silently inert for exactly those builds.
  const outDir = resolve(outDirInput);
  const pages = await walkHtml(outDir);
  const seen = new Set<string>();
  const found: SriProtectedScript[] = [];
  for (const html of pages.sort()) {
    let source: string;
    try {
      source = await readFile(html, 'utf8');
    } catch {
      continue;
    }
    const htmlDir = join(html, '..');
    const markup = source.replace(HTML_COMMENT, '');
    const tags = [
      ...(markup.match(SCRIPT_TAG) ?? []).map((tag) => ({ tag, url: SRC_ATTR.exec(tag)?.[1] })),
      ...(markup.match(PRELOAD_TAG) ?? [])
        .filter((tag) => PRELOADS_SCRIPT.test(tag))
        .map((tag) => ({ tag, url: HREF_ATTR.exec(tag)?.[1] })),
    ];
    for (const { tag, url } of tags) {
      const integrity = INTEGRITY_ATTR.exec(tag)?.[1];
      // An empty `integrity` pins nothing — browsers treat it as no check at all.
      if (integrity === undefined || unquote(integrity).trim() === '' || url === undefined) {
        continue;
      }
      const script = resolveLocalScript(outDir, htmlDir, unquote(url));
      // Only a JS file we emit can be broken by inject; a `.mjs`/`.cjs` counts, a `.wasm` does not.
      if (script === undefined || !/\.[cm]?js$/i.test(script) || seen.has(script)) {
        continue;
      }
      seen.add(script);
      found.push({ html, script, integrity: unquote(integrity).trim() });
    }
  }
  return found;
}

/** SRI's hash algorithms, weakest to strongest — the order the spec compares them in. */
const SRI_ALGORITHMS = ['sha256', 'sha384', 'sha512'] as const;
type SriAlgorithm = (typeof SRI_ALGORITHMS)[number];

/**
 * Whether `bytes` would pass `integrity`, by the browser's rule (SRI §3.3.5): unknown algorithms are
 * ignored; of what remains only the STRONGEST algorithm is compared; any one digest of it matching is
 * enough. A value with no algorithm the browser knows means no check at all.
 */
function passesIntegrity(integrity: string, bytes: Buffer): boolean {
  const byAlgorithm = new Map<SriAlgorithm, string[]>();
  for (const token of integrity.split(/\s+/)) {
    // `alg-base64[?options]` — the options suffix is allowed by the grammar and has no effect here.
    const [spec = ''] = token.split('?');
    const dash = spec.indexOf('-');
    const alg = spec.slice(0, dash) as SriAlgorithm;
    if (dash > 0 && SRI_ALGORITHMS.includes(alg)) {
      byAlgorithm.set(alg, [...(byAlgorithm.get(alg) ?? []), spec.slice(dash + 1)]);
    }
  }
  const strongest = [...SRI_ALGORITHMS].reverse().find((alg) => byAlgorithm.has(alg));
  if (strongest === undefined) {
    return true;
  }
  const actual = createHash(strongest).update(bytes).digest('base64');
  return (byAlgorithm.get(strongest) as string[]).includes(actual);
}

/**
 * Scripts in `outDir`'s HTML whose bytes no longer match the `integrity` value pinning them — i.e.
 * scripts the browser will refuse to run.
 *
 * The check for the IN-BUILD stamping path (stamp-assets.ts). There nothing is rewritten after emit,
 * so a build that stamped before its SRI plugin hashed is consistent, and this is empty. It is not
 * empty when some plugin hashed BEFORE the stamp — the one way the in-build path can still ship a page
 * that loads nothing — and saying so is the difference between a loud failure and a silent one.
 *
 * A pin to a file that is not on disk is skipped: a stale page pointing at a deleted bundle is broken,
 * but not by anything this build did. Never throws.
 */
export async function findIntegrityMismatches(outDirInput: string): Promise<SriProtectedScript[]> {
  const mismatched: SriProtectedScript[] = [];
  for (const pinned of await findSriProtectedScripts(outDirInput)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(pinned.script);
    } catch {
      continue;
    }
    if (!passesIntegrity(pinned.integrity, bytes)) {
      mismatched.push(pinned);
    }
  }
  return mismatched;
}
