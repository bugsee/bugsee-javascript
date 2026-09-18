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
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';

/** One `<script>` whose `integrity` pins a file in the build output. */
export interface SriProtectedScript {
  /** Absolute path of the HTML page carrying the attribute. */
  html: string;
  /** Absolute path of the script it pins. */
  script: string;
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
const INTEGRITY_ATTR = /\bintegrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;
const SRC_ATTR = /\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;

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
  const withoutQuery = src.split(/[?#]/)[0] ?? '';
  if (withoutQuery === '') {
    return undefined;
  }
  const full = isAbsolute(withoutQuery)
    ? // A root-relative `/assets/app.js` is served from the output root.
      join(outDir, withoutQuery)
    : resolve(htmlDir, withoutQuery);
  const inside = normalize(full).startsWith(normalize(outDir));
  return inside ? full : undefined;
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
export async function findSriProtectedScripts(outDir: string): Promise<SriProtectedScript[]> {
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
    for (const tag of source.match(SCRIPT_TAG) ?? []) {
      if (!INTEGRITY_ATTR.test(tag)) {
        continue;
      }
      const src = SRC_ATTR.exec(tag)?.[1];
      if (src === undefined) {
        continue;
      }
      const script = resolveLocalScript(outDir, htmlDir, unquote(src));
      // Only a JS file we emit can be broken by inject; a `.mjs`/`.cjs` counts, a `.wasm` does not.
      if (script === undefined || !/\.[cm]?js$/i.test(script) || seen.has(script)) {
        continue;
      }
      seen.add(script);
      found.push({ html, script });
    }
  }
  return found;
}
