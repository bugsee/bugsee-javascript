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
import { createReadStream, type Dirent } from 'node:fs';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

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

// An import map's `integrity` table pins modules by URL — how Angular's esbuild builder (v21+) pins its lazy
// chunks, which no tag mentions. The browser enforces it exactly like a tag's attribute.
const IMPORT_MAP = /<script\b[^>]*?\stype\s*=\s*("|')?importmap\1?[^>]*>([\s\S]*?)<\/script\s*>/gi;

/** `{ integrity, url }` for every entry of every import map's `integrity` table in `markup`. */
function importMapPins(markup: string): { integrity: string; url: string }[] {
  const pins: { integrity: string; url: string }[] = [];
  for (const [, , body = ''] of markup.matchAll(IMPORT_MAP)) {
    let table: unknown;
    try {
      table = (JSON.parse(body) as { integrity?: unknown }).integrity;
    } catch {
      continue; // not JSON: the browser ignores such a map too
    }
    if (typeof table === 'object' && table !== null) {
      for (const [url, integrity] of Object.entries(table)) {
        if (typeof integrity === 'string') {
          pins.push({ integrity, url });
        }
      }
    }
  }
  return pins;
}

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

const HTML_FILE = /\.x?html?$/i;

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

/** Whether `dir` is `root` or below it. */
const isUnder = (root: string, dir: string): boolean => {
  const rel = relative(root, dir);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

const walkFiles = async (dir: string, wanted: RegExp, depth = 0): Promise<string[]> => {
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
      found.push(...(await walkFiles(full, wanted, depth + 1)));
    } else if (entry.isFile() && wanted.test(entry.name)) {
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
  const pages = await walkFiles(outDir, HTML_FILE);
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
    ].map(({ tag, url }) => {
      const integrity = INTEGRITY_ATTR.exec(tag)?.[1];
      return {
        integrity: integrity === undefined ? undefined : unquote(integrity),
        url: url === undefined ? undefined : unquote(url),
      };
    });
    for (const { integrity, url } of [...tags, ...importMapPins(markup)]) {
      // An empty `integrity` pins nothing — browsers treat it as no check at all.
      if (integrity === undefined || integrity.trim() === '' || url === undefined) {
        continue;
      }
      let script = resolveLocalScript(outDir, htmlDir, url);
      if (script !== undefined && url.startsWith('/') && !(await fileExists(script))) {
        // A root-relative src is served from the directory the page was built into, which is not the scanned
        // root when that root is an SSR output (browser/ beside server/): look from the page's own directory up.
        const bare = (url.split(/[?#]/)[0] ?? '').trim();
        for (let d = htmlDir; isUnder(outDir, d); d = dirname(d)) {
          if (await fileExists(join(d, bare))) {
            script = join(d, bare);
            break;
          }
        }
      }
      // Only a JS file we emit can be broken by inject; a `.mjs`/`.cjs` counts, a `.wasm` does not.
      if (script === undefined || !/\.[cm]?js$/i.test(script) || seen.has(script)) {
        continue;
      }
      seen.add(script);
      found.push({ html, script, integrity: integrity.trim() });
    }
  }
  return found;
}

/** SRI's hash algorithms, weakest to strongest — the order the spec compares them in. */
const SRI_ALGORITHMS = ['sha256', 'sha384', 'sha512'] as const;
type SriAlgorithm = (typeof SRI_ALGORITHMS)[number];

/** The digests of `integrity` the browser can evaluate, grouped by algorithm. Unknown algorithms are dropped. */
function digestsByAlgorithm(integrity: string): Map<SriAlgorithm, string[]> {
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
  return byAlgorithm;
}

/**
 * Whether `bytes` would pass `integrity`, by the browser's rule (SRI): unknown algorithms are
 * ignored; of what remains only the STRONGEST algorithm is compared; any one digest of it matching is
 * enough. A value with no algorithm the browser knows means no check at all.
 */
function passesIntegrity(integrity: string, bytes: Buffer): boolean {
  const byAlgorithm = digestsByAlgorithm(integrity);
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

const SCRIPT_FILE = /\.[cm]?js$/i;

/**
 * Text files that can carry a copy of a script's hash: the page itself, the server modules that embed it, and
 * the scripts that hold a table of other scripts' hashes (the webpack builder's runtime chunk).
 */
const RESEAL_FILE = /\.(x?html?|[cm]?js)$|^ngsw\.json$/i;

/** The files {@link resealIntegrity} may rewrite under `dirs`: pages, server modules, scripts. */
export async function listResealFiles(dirs: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of dirs) {
    for (const file of await walkFiles(resolve(dir), RESEAL_FILE)) {
      found.add(file);
    }
  }
  return [...found];
}

/** Rounds of re-sealing: a table inside a script changes that script's own hash, which is one more round. */
const MAX_RESEAL_PASSES = 5;

type Digests = Record<SriAlgorithm, string>;

const digestsOf = (bytes: Buffer): Digests => ({
  sha256: createHash('sha256').update(bytes).digest('base64'),
  sha384: createHash('sha384').update(bytes).digest('base64'),
  sha512: createHash('sha512').update(bytes).digest('base64'),
});

/** What every script under some directories hashed to at one moment: the input of {@link resealIntegrity}. */
export type ScriptDigests = Map<string, Digests>;

/**
 * Record the digests of every script (`.js`/`.mjs`/`.cjs`) under `dirs`, BEFORE something rewrites them.
 *
 * Taken from the files, not from the pages that pin them: a hash can live where no tag mentions it — an
 * import map's table, or a table inside the webpack builder's runtime chunk, which pins every lazy chunk.
 */
export async function snapshotScriptDigests(dirs: readonly string[]): Promise<ScriptDigests> {
  const snapshot: ScriptDigests = new Map();
  for (const dir of dirs) {
    for (const file of await walkFiles(resolve(dir), SCRIPT_FILE)) {
      snapshot.set(file, digestsOf(await readFile(file)));
    }
  }
  return snapshot;
}

/**
 * Re-seal a build whose scripts changed AFTER their hashes were written: for every script whose bytes differ
 * from `before` (a {@link snapshotScriptDigests}), replace its old digests with its current ones, in every HTML
 * page, `.mjs` module and script under `dirs`. A script that is gone is skipped.
 *
 * A digest is the same length whatever it hashes, so a rewrite never moves a byte offset: source maps stay
 * valid. Rewriting a table inside a script changes THAT script, so the pass repeats (bounded) until nothing
 * is stale; a build whose hashes cannot be brought to rest is left for the caller's
 * {@link findIntegrityMismatches} to report. Sound where every copy of a hash is a literal in those files —
 * Angular's pages, its SSR copies of them, the webpack builder's runtime table. Not for a hash computed at
 * run time. Returns the files it rewrote. A missing directory is skipped.
 */
export async function resealIntegrity(
  before: ScriptDigests,
  dirs: readonly string[],
): Promise<{ files: string[] }> {
  const known: ScriptDigests = new Map(
    [...before].map(([file, digests]) => [file, { ...digests }]),
  );
  const rewritten = new Set<string>();
  for (let pass = 0; pass < MAX_RESEAL_PASSES; pass++) {
    const swaps = new Map<string, string>();
    for (const [file, digests] of known) {
      let bytes: Buffer;
      try {
        bytes = await readFile(file);
      } catch {
        continue;
      }
      const now = digestsOf(bytes);
      for (const alg of SRI_ALGORITHMS) {
        if (now[alg] !== digests[alg]) {
          swaps.set(`${alg}-${digests[alg]}`, `${alg}-${now[alg]}`);
          // What this script's pages hold now, for the next pass.
          digests[alg] = now[alg];
        }
      }
    }
    if (swaps.size === 0) {
      break;
    }
    for (const dir of dirs) {
      for (const file of await walkFiles(resolve(dir), RESEAL_FILE)) {
        const text = await readFile(file, 'utf8');
        let after = text;
        for (const [stale, fresh] of swaps) {
          after = after.split(stale).join(fresh);
        }
        if (after !== text) {
          await writeFile(file, after, 'utf8');
          rewritten.add(file);
        }
      }
    }
  }
  // After the last pass, so every file a manifest lists is final: the service worker's own hashes (below).
  for (const manifest of await findManifests(dirs)) {
    const text = await readFile(manifest.path, 'utf8');
    let after = text;
    for (const { url, recorded, actual } of manifest.entries) {
      if (actual !== undefined && actual !== recorded) {
        const entry = new RegExp(`(${escapeRegExp(JSON.stringify(url))}\\s*:\\s*")${recorded}(")`);
        after = after.replace(entry, `$1${actual}$2`);
      }
    }
    if (after !== text) {
      await writeFile(manifest.path, after, 'utf8');
      rewritten.add(manifest.path);
    }
  }
  return { files: [...rewritten] };
}

/**
 * Files under `dirs` that STILL hold an old digest of a script that has changed since `before`: a copy the swap
 * did not fix (the check {@link resealIntegrity} is verified by, over every directory it was given, not just the one
 * the pages are read from). Empty means every copy it could see was brought up to date.
 */
export async function findStaleDigests(
  before: ScriptDigests,
  dirs: readonly string[],
): Promise<{ file: string; script: string }[]> {
  const tokens = new Map<string, string>();
  for (const [script, old] of before) {
    let bytes: Buffer;
    try {
      bytes = await readFile(script);
    } catch {
      continue;
    }
    const now = digestsOf(bytes);
    for (const alg of SRI_ALGORITHMS) {
      if (now[alg] !== old[alg]) {
        tokens.set(`${alg}-${old[alg]}`, script);
      }
    }
  }
  const stale: { file: string; script: string }[] = [];
  if (tokens.size === 0) {
    return stale;
  }
  // One pass per file over every digest-shaped token (exact lengths: 256 -> 43 chars + `=`, 384 -> 64, 512 -> 86 + `==`),
  // looked up in a map, instead of a substring search per changed script per file.
  const shaped = /sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==/g;
  for (const file of await listResealFiles(dirs)) {
    const text = await readFile(file, 'utf8');
    for (const [found] of text.matchAll(shaped)) {
      const script = tokens.get(found);
      if (script !== undefined) {
        stale.push({ file, script });
        break;
      }
    }
  }
  return stale;
}

/** Whether any directory holds an `ngsw.json`: the one thing besides a pinned hash that a re-seal has to fix. */
export async function hasServiceWorkerManifest(dirs: readonly string[]): Promise<boolean> {
  for (const dir of dirs) {
    if ((await walkFiles(resolve(dir), /^ngsw\.json$/)).length > 0) {
      return true;
    }
  }
  return false;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface ManifestEntry {
  url: string;
  recorded: string;
  /** SHA-1 of the file the URL names, `undefined` when no such file is under the manifest's directory. */
  actual: string | undefined;
}

/** SHA-1 (hex) of a file, streamed. `undefined` when there is no such regular file (a missing path, a directory). */
async function sha1OfFile(path: string): Promise<string | undefined> {
  try {
    return await new Promise<string>((done, fail) => {
      const hash = createHash('sha1');
      createReadStream(path)
        .on('error', fail)
        .on('data', (chunk) => hash.update(chunk))
        .on('end', () => done(hash.digest('hex')));
    });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return undefined;
    }
    throw error; // a file that is there but cannot be read must not look like "nothing to compare"
  }
}

/**
 * SHA-1 of the file a manifest URL names, looked for under the manifest's directory with leading segments dropped
 * (base href). Streamed: a manifest lists every cached asset, media included, and none is buffered whole.
 */
async function hashManifestTarget(dir: string, url: string): Promise<string | undefined> {
  const segments = url.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    return undefined;
  }
  for (let from = 0; from < segments.length; from++) {
    const digest = await sha1OfFile(join(dir, ...segments.slice(from)));
    if (digest !== undefined) {
      return digest;
    }
  }
  return undefined;
}

/** Every `ngsw.json` under `dirs` with a `hashTable`, and what each entry's file hashes to now. */
async function findManifests(
  dirs: readonly string[],
): Promise<{ path: string; entries: ManifestEntry[] }[]> {
  const found = new Set<string>();
  for (const dir of dirs) {
    for (const file of await walkFiles(resolve(dir), /^ngsw\.json$/)) {
      found.add(file);
    }
  }
  const manifests: { path: string; entries: ManifestEntry[] }[] = [];
  for (const path of found) {
    let table: unknown;
    try {
      table = (JSON.parse(await readFile(path, 'utf8')) as { hashTable?: unknown }).hashTable;
    } catch {
      continue; // not JSON: nothing this can say about it
    }
    if (typeof table !== 'object' || table === null) {
      continue;
    }
    const entries: ManifestEntry[] = [];
    for (const [url, recorded] of Object.entries(table)) {
      if (typeof recorded !== 'string') {
        continue;
      }
      entries.push({ url, recorded, actual: await hashManifestTarget(dirname(path), url) });
    }
    manifests.push({ path, entries });
  }
  return manifests;
}

/**
 * Entries of a service worker manifest whose recorded SHA-1 is not the file's: the service worker would treat the
 * app as corrupt and stop serving it. An entry whose file cannot be found is not reported (nothing to compare).
 */
export async function findStaleServiceWorkerEntries(
  dirs: readonly string[],
): Promise<{ manifest: string; url: string }[]> {
  const stale: { manifest: string; url: string }[] = [];
  for (const manifest of await findManifests(dirs)) {
    for (const { url, recorded, actual } of manifest.entries) {
      if (actual !== undefined && actual !== recorded) {
        stale.push({ manifest: manifest.path, url });
      }
    }
  }
  return stale;
}
