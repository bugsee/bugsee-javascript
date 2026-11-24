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
// every dynamic import.
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { readRegularFile } from './safe-read';

/** A page larger than this is not scanned (a real page is a few KB): the scan must stay bounded on hostile input. */
export const MAX_HTML_BYTES = 8 * 1024 * 1024;

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
 * Every `<script>` tag, captured with its attributes. Deliberately not a parser: this is a guard, and the shapes
 * that matter are the ones bundlers emit (minified, attributes in any order, quoted or bare). A tag we fail to
 * parse is a tag we do not flag, which is the pre-existing behaviour: this can only ever be MORE cautious than
 * shipping the page blind. Found by {@link findTags}, a LINEAR scan (the regex `/<script\b[^>]*>/gi` it replaces
 * was quadratic on a page that is thousands of unterminated `<script `).
 */
// A `<link rel=modulepreload integrity>` pins a chunk just as hard: the preload fails the integrity
// check, poisons the module map, and the later `import()` of that chunk fails with it. Angular's
// builder and the Vite SRI plugins emit these alongside the entry `<script>`.
const PRELOADS_SCRIPT = /\brel\s*=\s*("|')?(modulepreload|preload)\1?/i;

/** `<name ...>` tags of `markup` (case-insensitive name, then a word boundary, up to the first `>`). Linear. */
export function findTags(markup: string, name: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (let open = markup.indexOf('<', from); open !== -1; open = markup.indexOf('<', from)) {
    from = open + 1;
    if (markup.slice(open + 1, open + 1 + name.length).toLowerCase() !== name) {
      continue;
    }
    if (/\w/.test(markup.charAt(open + 1 + name.length))) {
      continue; // `<scripts>`, `<linkage>`: the name must end at a word boundary
    }
    const close = markup.indexOf('>', open);
    if (close === -1) {
      break; // no `>` anywhere after this point: no later tag can be closed either
    }
    tags.push(markup.slice(open, close + 1));
    from = close + 1;
  }
  return tags;
}

/**
 * `source` without its HTML comments (`<!-- ... -->` is not markup: `<!-- <script src=app.js integrity=...> -->`
 * used to refuse the build). An unterminated `<!--` is left as it is. Linear: once no `-->` follows, none ever will.
 */
export function stripComments(source: string): string {
  let out = '';
  let at = 0;
  for (let open = source.indexOf('<!--', at); open !== -1; open = source.indexOf('<!--', at)) {
    const close = source.indexOf('-->', open + 4);
    if (close === -1) {
      break; // no `-->` anywhere after this point: no later comment can be closed either
    }
    out += source.slice(at, open);
    at = close + 3;
  }
  return out + source.slice(at);
}
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

const walkHtml = async (
  dir: string,
  fenced: boolean,
  links: Set<string>,
  depth = 0,
): Promise<string[]> => {
  if (fenced && depth > MAX_DEPTH) {
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
      // Unfenced (an output directory the doctor audits in full) still never enters node_modules or .git.
      const skip = fenced
        ? NEVER_WALK.has(entry.name) || entry.name.startsWith('.')
        : entry.name === 'node_modules' || entry.name === '.git';
      if (skip) {
        continue;
      }
      for (const page of await walkHtml(full, fenced, links, depth + 1)) {
        found.push(page);
      }
    } else if ((entry.isFile() || entry.isSymbolicLink()) && /\.x?html?$/i.test(entry.name)) {
      found.push(full);
      if (entry.isSymbolicLink()) {
        links.add(full);
      }
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
  // No page cap here: this is the guard stamping relies on, and a pin it cannot see is a script stamping would
  // break. Only the diagnostic (which must stay bounded on hostile input) passes a cap.
  const scripts = (await findSriProtectedScriptsDetailed(outDirInput, Number.POSITIVE_INFINITY))
    .scripts;
  // One entry per script (the first pin found): stamping asks "is this script pinned at all", the doctor wants every pin.
  const seen = new Set<string>();
  return scripts.filter((pin) => !seen.has(pin.script) && seen.add(pin.script));
}

/** What {@link findSriProtectedScripts} found, and the pages it did not scan because they are larger than {@link MAX_HTML_BYTES}. */
export interface SriScan {
  scripts: SriProtectedScript[];
  skippedPages: Array<{ html: string; size: number }>;
  /** Pages that exist but could not be read (permissions, a race): their pins were NOT checked. */
  unreadablePages: string[];
}

export async function findSriProtectedScriptsDetailed(
  outDirInput: string,
  maxHtmlBytes: number = MAX_HTML_BYTES,
  /** Skip `test`/dot-directories and stop below depth 6 (the stamp guard's default; the doctor passes its own fence). */
  fenced = true,
): Promise<SriScan> {
  // Resolved FIRST: a bundler hands us whatever the user configured, and Rollup passes `output.dir`
  // through verbatim (`'dist'`) while `output.file: 'bundle.js'` resolves to `'.'`. Comparing an
  // absolute resolved script path against a relative root made every `src="main.js"` look like it
  // was outside the output directory, so the guard was silently inert for exactly those builds.
  const outDir = resolve(outDirInput);
  const links = new Set<string>();
  const pages = await walkHtml(outDir, fenced, links);
  const realOutDir = await realpath(outDir).catch(() => outDir);
  const seen = new Set<string>();
  const found: SriProtectedScript[] = [];
  const skippedPages: SriScan['skippedPages'] = [];
  const unreadablePages: string[] = [];
  for (const html of pages.sort()) {
    // A symlinked page is read through its REAL path, and only if that stays inside the output directory (the
    // same rule as every other symlinked artifact); one that leads out, or dangles, is a page that was not checked.
    let readPath = html;
    if (links.has(html)) {
      const real = await realpath(html).catch(() => undefined);
      if (real === undefined || !(real === realOutDir || real.startsWith(realOutDir + sep))) {
        unreadablePages.push(html);
        continue;
      }
      readPath = real;
    }
    const read = await readRegularFile(readPath, maxHtmlBytes);
    if (!read.ok) {
      if (read.tooLarge !== undefined) {
        skippedPages.push({ html, size: read.tooLarge.size });
      } else {
        unreadablePages.push(html); // any other failure: the page's pins were NOT checked, and that is said
      }
      continue;
    }
    const htmlDir = join(html, '..');
    const markup = stripComments(read.bytes.toString('utf8'));
    const tags = [
      ...findTags(markup, 'script').map((tag) => ({ tag, url: SRC_ATTR.exec(tag)?.[1] })),
      ...findTags(markup, 'link')
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
      const pin = unquote(integrity).trim();
      if (script === undefined || !/\.[cm]?js$/i.test(script) || seen.has(`${script}\0${pin}`)) {
        continue;
      }
      seen.add(`${script}\0${pin}`);
      found.push({ html, script, integrity: pin });
    }
  }
  return { scripts: found, skippedPages, unreadablePages };
}

/** SRI's hash algorithms, weakest to strongest — the order the spec compares them in. */
const SRI_ALGORITHMS = ['sha256', 'sha384', 'sha512'] as const;
type SriAlgorithm = (typeof SRI_ALGORITHMS)[number];

/**
 * Whether `bytes` would pass `integrity`, by the browser's rule (SRI): unknown algorithms are
 * ignored; of what remains only the STRONGEST algorithm is compared; any one digest of it matching is
 * enough. A value with no algorithm the browser knows means no check at all.
 */
export function passesIntegrity(integrity: string, bytes: Buffer): boolean {
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
