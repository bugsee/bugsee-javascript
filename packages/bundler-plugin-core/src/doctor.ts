// `sourcemaps doctor` — the OFFLINE half. Reads a build output directory exactly as it sits on disk and says
// why a crash from it would (not) symbolicate, without a network call, a token, or a backend.
//
// Every finding has a stable check ID, a severity, a human message and a fix hint, and the report has one
// versioned JSON shape (`DoctorReport`) that the Rust `bugsee-cli sourcemaps doctor` is specified to emit
// too (see the design hand-off), so a CI step can consume either. Pure reads: nothing is written or deleted.
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import nodePath, { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAppIdentity } from './app-identity';
import { readDebugId } from './debug-ids';
import { loadBuildPluginEnv, mergeBuildPluginEnv } from './env-file';
import type { EnvRecord } from './run-cli';
import { type ReadResult, readRegularFile } from './safe-read';
import { findSriProtectedScriptsDetailed, MAX_HTML_BYTES, passesIntegrity } from './sri';
import { cutAtQuery, isProjectRootOrAbove, MAX_WALK_DEPTH, NEVER_WALK } from './stamp-files';
import { lastSourceMappingUrl, localPointerTarget } from './verify-stamp';

/** Bumped on any incompatible change to `DoctorReport`; the Rust command emits the same number. */
export const DOCTOR_SCHEMA_VERSION = 1;

export type DoctorSeverity = 'error' | 'warning' | 'info';

/** One thing the doctor found. `id` is stable across releases and is what tooling should match on. */
export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  message: string;
  /** What to do about it. Omitted for purely informational findings. */
  fix?: string;
  /** The file concerned, relative to the checked directory (POSIX separators). */
  file?: string;
  /** Machine-readable specifics (counts, ids, paths); never contains a secret. */
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  schemaVersion: typeof DOCTOR_SCHEMA_VERSION;
  tool: 'bugsee-sourcemaps-doctor';
  /** Absolute path of the checked directory. */
  dir: string;
  summary: { errors: number; warnings: number; infos: number; bundles: number; maps: number };
  /** Check IDs that ran and found nothing wrong. */
  passed: string[];
  findings: DoctorFinding[];
  /** Check IDs dropped by `ignore`; omitted when none were. */
  ignored?: string[];
}

export interface DoctorOptions {
  /** Environment to resolve the token / version / build from. Defaults to `process.env`. */
  env?: EnvRecord;
  /** An explicit token (the `appToken` plugin option). Never echoed. */
  appToken?: string;
  appVersion?: string;
  appBuild?: string;
  /** Where `.env.bugsee-build-plugin` and `package.json` are looked up from. Defaults to the working directory. */
  projectRoot?: string;
  /** A map larger than this many bytes is flagged. Default 50 MiB. */
  maxMapBytes?: number;
  /** Skip the `env.*` checks (an output-only audit, e.g. in a container with no token). */
  skipEnv?: boolean;
  /**
   * The directory is (about to be) served to the public: leftover `.map` files are then a WARNING (they expose
   * source) instead of a note. Off by default so `--strict` works straight after a plugin run.
   */
  deployed?: boolean;
  /** Check IDs to drop from the report (repeatable `--ignore`). */
  ignore?: readonly string[];
  /** A script larger than this many bytes is not read (default 512 MiB). */
  maxBundleBytes?: number;
  /**
   * Globs (relative to the checked directory, POSIX separators; `*` stays in a directory, `**` crosses them, `?` is
   * one character, a trailing `/` means the directory) of files the build did NOT emit: a doctor cannot tell a
   * script copied in (Vite `publicDir`, a copy plugin) from a bundle that lost its stamp, and the plugin never stamps
   * the former. Matching files are dropped before analysis and listed as `output.excluded`.
   */
  exclude?: readonly string[];
}

const DEFAULT_MAX_MAP_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
/** Files read at once: bounds open handles. */
const READ_CONCURRENCY = 16;
/** Bytes read at once (a batch of sixteen 512 MiB scripts is 8 GiB): a single larger file is still read, alone. */
const READ_BYTE_BUDGET = 256 * 1024 * 1024;

/**
 * Where the batch starting at `start` ends (exclusive): at most `maxCount` files and `budget` bytes, but always at
 * least one file. `sizes` are what `stat` reported.
 */
export function batchEnd(
  sizes: readonly number[],
  start: number,
  maxCount: number,
  budget: number,
): number {
  let end = start + 1;
  let total = sizes[start] ?? 0;
  while (end < sizes.length && end - start < maxCount && total + (sizes[end] ?? 0) <= budget) {
    total += sizes[end] ?? 0;
    end++;
  }
  return end;
}
const BUNDLE = /\.[cm]?js$/i;
const MAP = /\.map$/i;
/** The global the runtime stub writes the id into (`@bugsee/browser` reads it at crash time). */
const REGISTRATION = '_bugseeDebugIds';
const MAX_LISTED = 5;

/** Every ID the doctor can emit, in report order. Exported so docs / the Rust port can be checked against it. */
export const DOCTOR_CHECK_IDS = [
  'output.dir-missing',
  'output.no-js',
  'output.unreadable',
  'output.dir-unreadable',
  'output.excluded',
  'output.exclude-unmatched',
  'output.walk-fenced',
  'stamp.missing-debug-id',
  'stamp.missing-registration',
  'stamp.map-id-mismatch',
  'stamp.map-no-debug-id',
  'stamp.mixed',
  'stamp.duplicate-debug-id',
  'map.pointer-dangling',
  'map.hidden',
  'map.inline',
  'map.invalid',
  'map.no-sources',
  'map.sources-content',
  'map.sources-unresolvable',
  'map.too-large',
  'map.unreadable',
  'map.pointer-outside-dir',
  'map.public-leftover',
  'sri.unstamped-hazard',
  'sri.mismatch',
  'sri.html-skipped',
  'sri.pin-unreadable',
  'sri.manifest-hashes',
  'build.dev-bundle',
  'env.token-source',
  'env.token-missing',
  'env.version-unresolved',
  'env.build-unresolved',
  'env.node-env-development',
  'doctor.internal-error',
] as const;
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

/** Hard failures: `--ignore` never hides these (it would turn "nothing was checked" into a pass). */
export const NON_IGNORABLE_CHECK_IDS: ReadonlySet<string> = new Set([
  'output.dir-missing',
  'output.no-js',
  'doctor.internal-error',
]);

const posix = (path: string): string => path.split('\\').join('/');

/** `bundle.js.map` -> the same name as written in the report; always relative to `dir`. */
const rel = (dir: string, path: string): string => posix(relative(dir, path));

/**
 * Every script and map under `root`, and the directories the fence skipped. An output directory is walked in full
 * (Rollup `preserveModules` writes `dist/src/*.js`; a build may emit `dist/test/`), skipping only `node_modules`
 * and `.git`; the fence on `src`/`test`/dot-directories and the depth cap apply ONLY when `root` is a project
 * directory (has a `package.json`) that is, or contains, the working directory, where they keep the walk out of the
 * source tree. What the fence skipped is returned, never silent. Iterative, and never spreads a result list (a
 * directory with 100k files must not overflow the call stack).
 */
export async function walkDetailed(
  root: string,
): Promise<{ files: string[]; skipped: string[]; fenced: boolean; unreadable: string[] }> {
  const fenced = (await isProjectRootOrAbove(root)) && existsSync(join(root, 'package.json'));
  const found: string[] = [];
  const skipped: string[] = [];
  const unreadable: string[] = [];
  // Real directories already queued: a symlink to one (a loop, an alias) must not be walked, or counted, twice.
  const realRoot = await realpath(root).catch(() => root);
  const visited = new Set<string>([realRoot]);
  type Queued = { dir: string; depth: number; real: string };
  const pending: Queued[] = [{ dir: root, depth: 0, real: realRoot }];
  // Links to directories inside the output are followed only AFTER every real directory has been walked, so a real
  // directory always wins over an alias whatever the names sort like: every file is reported (and excluded, and
  // stamped) under its real path.
  const deferred: Queued[] = [];
  const drain = async (): Promise<void> => {
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      await visitDir(next);
    }
  };
  const visitDir = async (next: Queued): Promise<void> => {
    if (fenced && next.depth > MAX_WALK_DEPTH) {
      skipped.push(rel(root, next.dir));
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      // A directory whose scripts and maps were NOT seen: reported, never a silent pass.
      unreadable.push(rel(root, next.dir) || '.');
      return;
    }
    for (const entry of entries) {
      const full = join(next.dir, entry.name);
      const link = entry.isSymbolicLink() && !BUNDLE.test(entry.name) && !MAP.test(entry.name);
      if (entry.isDirectory() || link) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }
        if (fenced && (NEVER_WALK.has(entry.name) || entry.name.startsWith('.'))) {
          skipped.push(rel(root, full));
          continue;
        }
        const real = join(next.real, entry.name);
        if (link) {
          // A symlinked directory is followed only if it stays inside the output directory; one that leaves it is a
          // directory whose scripts were NOT seen (a link to a file, or a dangling one, has nothing to audit).
          const target = await realpath(full).catch(() => undefined);
          if (
            target === undefined ||
            !(await stat(target).then(
              (info) => info.isDirectory(),
              /* v8 ignore start -- the link vanished between realpath and stat: a race that cannot be reproduced deterministically */
              () => false,
              /* v8 ignore stop */
            ))
          ) {
            continue;
          }
          if (!(target === realRoot || target.startsWith(realRoot + sep))) {
            unreadable.push(rel(root, full));
            continue;
          }
          deferred.push({ dir: full, depth: next.depth + 1, real: target });
        } else if (!visited.has(real)) {
          visited.add(real);
          pending.push({ dir: full, depth: next.depth + 1, real });
        }
      } else if (BUNDLE.test(entry.name) || MAP.test(entry.name)) {
        found.push(full);
      }
    }
  };
  await drain();
  // (`deferred` can grow while it is processed: a followed link's tree may hold more links.)
  for (let i = 0; i < deferred.length; i++) {
    const link = deferred[i] as Queued;
    if (!visited.has(link.real)) {
      visited.add(link.real);
      pending.push(link);
      await drain();
    }
  }
  return { files: found.sort(), skipped: skipped.sort(), fenced, unreadable: unreadable.sort() };
}

export async function walk(root: string): Promise<string[]> {
  return (await walkDetailed(root)).files;
}

/** A glob (see {@link DoctorOptions.exclude}) as an anchored regular expression over a POSIX relative path. */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.endsWith('/') ? `${glob}**` : glob;
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === '*') {
      if (pattern.charAt(i + 1) === '*') {
        const slash = pattern.charAt(i + 2) === '/';
        source += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * The `sources` and their embedded `sourcesContent` (aligned by index) of a map. An ordinary map has them at the top
 * level; an INDEX map keeps them inside `sections[].map`, so those are concatenated, each section's content padded to
 * its own sources so the alignment survives.
 */
export function mapSources(json: Record<string, unknown>): {
  sources: unknown[];
  content: unknown[];
  roots: string[];
  hasOriginal: boolean;
} {
  let hasOriginal = false;
  const sources: unknown[] = [];
  const content: unknown[] = [];
  const roots: string[] = [];
  const collect = (map: Record<string, unknown>, depth: number): void => {
    if (Array.isArray(map.sources) && map.sources.length > 0) {
      // A leaf map: its content and sourceRoot belong to ITS sources only (aligned by index).
      const own = map.sources as unknown[];
      const embedded = Array.isArray(map.sourcesContent) ? (map.sourcesContent as unknown[]) : [];
      const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
      hasOriginal ||= typeof map.mappings === 'string' && hasOriginalPosition(map.mappings);
      own.forEach((source, i) => {
        sources.push(source);
        content.push(embedded[i]);
        roots.push(root);
      });
      return;
    }
    if (depth >= MAX_INDEX_DEPTH) {
      return;
    }
    // An INDEX map keeps its maps inside `sections[].map`, which may be index maps themselves.
    for (const section of Array.isArray(map.sections) ? (map.sections as unknown[]) : []) {
      const inner = (section as { map?: unknown } | null)?.map;
      if (typeof inner === 'object' && inner !== null) {
        collect(inner as Record<string, unknown>, depth + 1);
      }
    }
  };
  collect(json, 0);
  return { sources, content, roots, hasOriginal };
}

/** Nested index maps are followed this deep (a real one is 1-2 levels); a hostile chain must not overflow the stack. */
const MAX_INDEX_DEPTH = 32;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Whether a `mappings` string has at least one segment that names an ORIGINAL position (four or more VLQ values:
 * generated column, source, line, column). A map made only of generated-position segments (or empty) cannot map any
 * frame back to your code. A segment with a character outside the base64 alphabet is unusable and does not count.
 */
export function hasOriginalPosition(mappings: string): boolean {
  // One pass, no split: the first usable segment answers, so a healthy map costs a handful of characters.
  let values = 0;
  let usable = true;
  for (let i = 0; i < mappings.length; i++) {
    const ch = mappings.charAt(i);
    if (ch === ',' || ch === ';') {
      if (usable && values >= 4) {
        return true;
      }
      values = 0;
      usable = true;
      continue;
    }
    const digit = BASE64.indexOf(ch);
    if (digit < 0) {
      usable = false;
    } else if ((digit & 32) === 0) {
      values++; // no continuation bit: this digit ends a value
    }
  }
  return usable && values >= 4;
}

/**
 * Memoise an async computation per key, keeping at most `limit` results (least recently used out first). Used so a
 * map that many bundles share is read and parsed once, without keeping every map of a big build in memory.
 */
export function boundedMemo<V>(
  limit: number,
  compute: (key: string) => Promise<V>,
): (key: string) => Promise<V> {
  const cache = new Map<string, Promise<V>>();
  return (key) => {
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit); // most recently used goes last
      return hit;
    }
    const value = compute(key);
    cache.set(key, value);
    if (cache.size > limit) {
      cache.delete(cache.keys().next().value as string);
    }
    return value;
  };
}

interface ParsedMap {
  ok: true;
  json: Record<string, unknown>;
  debugId: string | undefined;
}

function parseMap(text: string): ParsedMap | { ok: false; why: string } {
  if (text.startsWith('\uFEFF')) {
    return {
      ok: false,
      why: 'not valid JSON: it starts with a UTF-8 byte order mark (BOM), which the upload rejects',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, why: 'not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, why: 'not a JSON object' };
  }
  const json = parsed as Record<string, unknown>;
  const id = [json.debugId, json.debug_id].find((v) => typeof v === 'string' && v !== '');
  return { ok: true, json, debugId: typeof id === 'string' ? id.toLowerCase() : undefined };
}

/** Paths probed to ask "would these patterns hide everything the doctor could find in this directory". */
const DIR_PROBES = [
  'zz-probe-1/zz-probe-2/c.js',
  'zz-probe-1/zz-probe-2/c.mjs',
  'zz-probe-1/zz-probe-2/c.cjs',
  'zz-probe-1/zz-probe-2/c.js.map',
  'zz-probe-1/zz-probe-2/c.map',
  'zz-probe-1/zz-probe-2/c.html',
  'zz-probe-1/zz-probe-2/c.htm',
  'zz-probe-1/zz-probe-2/c',
];

/** `scheme://...`: a URL, not a directory name. */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Sources that name no file on disk by construction (bundler runtime, virtual modules). */
const VIRTUAL_SOURCE = /^(webpack\/|\(webpack\)|\0|<|rollup:|vite\/)|\0/;

/**
 * Resolve a map `sources` entry as a debugger would. `file://` URLs follow `fileURLToPath` (so `file:///C:/x`
 * is `C:\x` on Windows and a bad escape is "unknowable", not an exception). A bundler-scheme path
 * (`webpack://app/./src/x.ts`) is relative to the PROJECT root, not to the map. Anything else is resolved from
 * the map's directory and its `sourceRoot`. Undefined means "names no file on disk" (virtual / unparseable).
 */
export function sourcePath(
  mapDir: string,
  sourceRoot: string,
  source: string,
  projectRoot: string = mapDir,
  api: typeof nodePath = nodePath,
): string | undefined {
  let path = source;
  let fromProject = false;
  // ECMA-426: the source URL is `sourceRoot + source`. A scheme in the root (`webpack:///` + `src/x.ts`) is the
  // same URL as the scheme written into `source`, so it takes the same rule below.
  if (
    SCHEME_URL.test(sourceRoot) &&
    !/^[a-z][a-z0-9+.-]*:/i.test(source) &&
    !api.isAbsolute(source)
  ) {
    path = sourceRoot.endsWith('/') ? `${sourceRoot}${source}` : `${sourceRoot}/${source}`;
  }
  if (/^file:\/\//i.test(path)) {
    try {
      return fileURLToPath(path, { windows: api === nodePath.win32 });
    } catch {
      return undefined;
    }
  }
  if (SCHEME_URL.test(path)) {
    // `webpack://app/./src/x.ts` and friends: the scheme/namespace is not a directory; drop it.
    path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, '');
    fromProject = true;
  }
  if (VIRTUAL_SOURCE.test(path) || path === '') {
    return undefined;
  }
  if (api.isAbsolute(path)) {
    return path;
  }
  return fromProject ? api.resolve(projectRoot, path) : api.resolve(mapDir, sourceRoot, path);
}

type InsideRead = { ok: true; bytes: Buffer; real: string } | Extract<ReadResult, { ok: false }>;

/**
 * Read `path` if, and only if, it is a regular file whose REAL path is inside `realRoot`. A symlink that resolves
 * inside the directory (pnpm-style `assets/app.js -> ../.store/app.js`) is read through its real path; one that
 * leads outside, dangles or loops is a value describing why, never a read. The open itself refuses a symlink,
 * blocks on nothing and judges type and size on the descriptor (see safe-read.ts), so there is no
 * check-then-use gap on the file.
 */
async function readInside(path: string, limit: number, realRoot: string): Promise<InsideRead> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    return {
      ok: false,
      reason: `could not be resolved (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
    };
  }
  if (!isInside(realRoot, real)) {
    return { ok: false, reason: 'resolves outside the output directory' };
  }
  const read = await readRegularFile(real, limit);
  return read.ok ? { ...read, real } : read;
}

/** Most entries a `details` list carries; `total` says how many there were. */
const MAX_DETAIL = 100;
const listDetails = (key: string, list: readonly unknown[]): Record<string, unknown> => ({
  [key]: list.slice(0, MAX_DETAIL),
  ...(list.length > MAX_DETAIL ? { total: list.length } : {}),
});

/** Whether `target` is `root` itself or inside it. */
function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === '' ||
    !(path === '..' || path.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(path))
  );
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * `*manifest*.json` files directly in `dir` that mention integrity hashes. Only the checked directory is ever read
 * (a page in the parent is not this build's to judge, and may be anything), through the bounded regular-file
 * reader, so a FIFO or a `/dev/zero` symlink named like a manifest is skipped, not opened.
 */
async function manifestsWithIntegrity(
  dir: string,
  limit: number,
  realRoot: string,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const name of names.sort()) {
    if (!/manifest.*\.json$/i.test(name)) {
      continue;
    }
    const read = await readInside(join(dir, name), limit, realRoot);
    if (
      read.ok &&
      /\bintegrity\b|["'](sha(256|384|512))-[A-Za-z0-9+/=]{20,}/i.test(read.bytes.toString('utf8'))
    ) {
      hits.push(join(dir, name));
    }
  }
  return hits;
}

/**
 * Audit the build output in `dirInput`. Never throws for a problem with the directory (that is a finding);
 * never writes; reads each script and map once, bounded by size, through the guarded reader (a duplicate-ID candidate is read a second time to compare contents).
 */
export async function diagnoseBuildOutput(
  dirInput: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  try {
    return await diagnose(dirInput, options);
  } catch (error) {
    // The contract is "never throws": whatever went wrong is the finding.
    return finish(
      resolve(String(dirInput)),
      [
        {
          id: 'doctor.internal-error',
          severity: 'error',
          message: `The doctor failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
          fix: 'This is a bug in the doctor; re-run with --json and report it with the directory layout.',
        },
      ],
      0,
      0,
      [],
      options.ignore,
    );
  }
}

async function diagnose(dirInput: string, options: DoctorOptions): Promise<DoctorReport> {
  const dir = resolve(dirInput);
  const findings: DoctorFinding[] = [];
  const failed = new Set<string>();
  const add = (finding: DoctorFinding): void => {
    findings.push(finding);
    failed.add(finding.id);
  };
  const env = options.env ?? (process.env as EnvRecord);
  const maxMapBytes = options.maxMapBytes ?? DEFAULT_MAX_MAP_BYTES;
  const maxBundleBytes = options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());

  let isDir = false;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    add({
      id: 'output.dir-missing',
      severity: 'error',
      message: `${dir} does not exist or is not a directory.`,
      fix: 'Run the build first, and pass the bundler output directory (e.g. dist, build, .output/public).',
    });
    return finish(dir, findings, 0, 0, [], options.ignore);
  }

  const realDir = await realpath(dir);
  const walked = await walkDetailed(dir);
  // `./public/**` is `public/**`: a leading `./` would otherwise match nothing, silently.
  const excludeGlobs = (options.exclude ?? []).map((glob) => glob.replace(/^(\.\/)+/, ''));
  const patterns = excludeGlobs.map(globToRegExp);
  const matchedPatterns = new Set<number>();
  const isExcludedName = (name: string): boolean => {
    let hit = false;
    patterns.forEach((pattern, i) => {
      if (pattern.test(name)) {
        matchedPatterns.add(i);
        hit = true;
      }
    });
    return hit;
  };
  const isExcluded = (path: string): boolean => isExcludedName(rel(dir, path));
  const excluded: string[] = [];
  const files = walked.files.filter((file) => {
    if (isExcluded(file)) {
      excluded.push(rel(dir, file));
      return false;
    }
    return true;
  });
  const bundles = files.filter((f) => BUNDLE.test(f));
  const maps = files.filter((f) => MAP.test(f));
  if (bundles.length === 0) {
    add({
      id: 'output.no-js',
      severity: 'error',
      message: `No .js/.cjs/.mjs files found under ${dir} (node_modules and .git are not searched).`,
      fix: 'Point the doctor at the bundler output directory, not the project root or a source tree.',
    });
  }

  if (excluded.length > 0) {
    add({
      id: 'output.excluded',
      severity: 'info',
      message: `${excluded.length} file(s) matched --exclude and were not checked (${excluded.slice(0, MAX_LISTED).join(', ')}${excluded.length > MAX_LISTED ? ', …' : ''}).`,
      details: listDetails('files', excluded),
    });
  }
  if (walked.skipped.length > 0) {
    add({
      id: 'output.walk-fenced',
      severity: 'info',
      message: `${walked.skipped.length} director${walked.skipped.length === 1 ? 'y was' : 'ies were'} not searched because ${dir} looks like a project directory (${walked.skipped.slice(0, MAX_LISTED).join(', ')}${walked.skipped.length > MAX_LISTED ? ', …' : ''}).`,
      fix: 'To audit them, run the doctor on the build output directory from the project root (not from inside a directory that has a package.json).',
      details: listDetails('directories', walked.skipped),
    });
  }

  const mapSet = new Set(maps);
  // A map reached through two names (a symlinked directory, a case-variant pointer) is the same file: judged once.
  const seenMaps = new Set<string>();
  // Relative sources resolve from the map URL's directory, so an alias in another directory has its own verdict.
  const seenBases = new Set<string>();
  const markSeen = (real: string): boolean => {
    if (seenMaps.has(real)) {
      return false;
    }
    seenMaps.add(real);
    return true;
  };
  const contentFacts: Array<{
    file: string;
    embeddedAll: boolean;
    message: string;
    details?: Record<string, unknown>;
  }> = [];
  // A map shared by many bundles is read and parsed once (a few at a time are kept: a build of mostly unique maps
  // must not retain them all).
  const loadMap = boundedMemo(4, async (path: string) => {
    const read = await readInside(path, maxMapBytes, realDir);
    return read.ok
      ? { ok: true as const, real: read.real, parsed: parseMap(read.bytes.toString('utf8')) }
      : read;
  });
  const claimedMaps = new Set<string>();
  const stampedIds = new Map<string, Array<{ file: string; path: string }>>();
  let stamped = 0;
  const unstamped = new Set<string>();
  const unstampedWithoutMap: string[] = [];
  const noRegistration: string[] = [];
  const dangling: string[] = [];
  const outsideDir: string[] = [];
  const devBundles: string[] = [];
  const inline = new Set<string>();
  const hidden: string[] = [];
  const unreadable: string[] = [];

  // Reads happen in bounded batches; analysis stays sequential so findings keep a deterministic order.
  const reads = new Map<string, InsideRead>();
  const readBatch = async (batch: readonly string[]): Promise<void> => {
    const results = await Promise.all(
      batch.map((path) => readInside(path, maxBundleBytes, realDir)),
    );
    batch.forEach((path, i) => {
      reads.set(path, results[i] as InsideRead);
    });
  };

  // What `stat` says each script weighs, to bound the bytes held at once (a failed stat weighs nothing: the read reports it).
  const sizes = await Promise.all(
    bundles.map((path) =>
      stat(path).then(
        (info) => info.size,
        () => 0,
      ),
    ),
  );
  let readEnd = 0;
  for (let at = 0; at < bundles.length; at++) {
    if (at >= readEnd) {
      reads.clear();
      readEnd = batchEnd(sizes, at, READ_CONCURRENCY, READ_BYTE_BUDGET);
      await readBatch(bundles.slice(at, readEnd));
    }
    const bundle = bundles[at] as string;
    const name = rel(dir, bundle);
    const read = reads.get(bundle) as InsideRead;
    if (!read.ok) {
      unreadable.push(`${name} ${read.reason}`);
      continue;
    }
    const code = read.bytes.toString('utf8');
    const id = readDebugId(code);

    if (code.includes('webpack-internal:///')) {
      devBundles.push(name);
    }

    // Which map belongs to this bundle: the one its pointer names, else the sibling `<bundle>.map`.
    const pointer = lastSourceMappingUrl(code);
    let mapPath: string | undefined;
    if (pointer !== undefined && pointer !== '') {
      if (/^data:/i.test(pointer)) {
        inline.add(name);
      } else {
        // The pairing rule the stamp itself uses (verify-stamp.ts): a LOCAL pointer, resolved from the
        // bundle's directory; remote / root-absolute / malformed pointers pair nothing.
        const raw = localPointerTarget(bundle, code, nodePath);
        // webpack / Rspack write `main.js?[hash]` to disk as `main.js` and keep the query in the pointer
        // (`main.js.map?[hash]`): a server drops the query when it maps the URL to a file, so does the doctor
        // (a file named with a `?` is not a `.map` file, so it could not have been paired anyway).
        const bundleDir = nodePath.dirname(bundle);
        const target =
          raw === undefined
            ? undefined
            : nodePath.join(bundleDir, cutAtQuery(nodePath.relative(bundleDir, raw)));
        if (target !== undefined) {
          if (!isInside(dir, target)) {
            // Never read it: a pointer can name `/dev/zero`, a FIFO or someone else's file.
            outsideDir.push(`${name} -> ${pointer}`);
          } else if (mapSet.has(target)) {
            mapPath = target;
          } else if (isExcluded(target)) {
            // an excluded map is not the build's: neither read nor reported as dangling
          } else {
            // A symlinked DIRECTORY on the way can lead out although the path looks inside: judge the
            // real path, never read through it.
            const real = await realpath(target).catch(() => undefined);
            if (real === undefined) {
              dangling.push(`${name} -> ${pointer}`);
            } else if (!isInside(realDir, real)) {
              outsideDir.push(`${name} -> ${pointer}`);
            } else {
              mapPath = target;
            }
          }
        }
      }
    }
    if (mapPath === undefined && mapSet.has(`${bundle}.map`)) {
      mapPath = `${bundle}.map`;
      if (pointer === undefined) {
        hidden.push(name);
      }
    }

    if (id === undefined) {
      unstamped.add(name);
      if (mapPath === undefined && !inline.has(name)) {
        unstampedWithoutMap.push(name);
      }
    } else {
      stamped++;
      const list = stampedIds.get(id) ?? [];
      list.push({ file: name, path: bundle });
      stampedIds.set(id, list);
      if (!code.includes(REGISTRATION)) {
        noRegistration.push(name);
      }
    }

    if (mapPath !== undefined) {
      claimedMaps.add(mapPath);
      const mapName = rel(dir, mapPath);
      const mapRead = await loadMap(mapPath);
      if (!mapRead.ok) {
        reportUnreadableMap(mapName, mapRead);
        continue;
      }
      const parsed = mapRead.parsed;
      if (!parsed.ok) {
        if (markSeen(mapRead.real)) {
          add({
            id: 'map.invalid',
            severity: 'error',
            file: mapName,
            message: `${mapName} is ${parsed.why}, so it cannot be uploaded or used to symbolicate.`,
            fix: 'Check the build is not truncating or post-processing the map; rebuild.',
          });
        }
        continue;
      }
      if (id !== undefined && parsed.debugId === undefined) {
        add({
          id: 'stamp.map-no-debug-id',
          severity: 'error',
          file: mapName,
          message: `${mapName} has no debugId, but its bundle ${name} carries ${id}; a crash cannot be matched to this map.`,
          fix: 'Stamp the bundle and map together (the Bugsee plugin or `bugsee-cli sourcemaps inject`), and make sure no later step regenerates the map.',
          details: { bundleDebugId: id },
        });
      } else if (id !== undefined && parsed.debugId !== undefined && parsed.debugId !== id) {
        add({
          id: 'stamp.map-id-mismatch',
          severity: 'error',
          file: mapName,
          message: `${mapName} has debugId ${parsed.debugId} but its bundle ${name} carries ${id}.`,
          fix: 'Re-run the stamp over the final files; a minifier or copy step ran after stamping.',
          details: { bundleDebugId: id, mapDebugId: parsed.debugId },
        });
      } else if (id === undefined && parsed.debugId !== undefined) {
        add({
          id: 'stamp.missing-debug-id',
          severity: 'error',
          file: name,
          message: `${name} has no debugId comment, but its map carries ${parsed.debugId}; the bundle lost its stamp.`,
          fix: 'Something rewrote the bundle after stamping. Stamp last, or use the in-build stamping plugin.',
          details: { mapDebugId: parsed.debugId },
        });
        // Counted once as unstamped above; do not double report below.
        unstamped.delete(name);
      }
      validateMap(mapPath, mapName, parsed.json, mapRead.real);
    }
  }

  // Maps nothing points at (hidden maps of bundles are claimed above; this is the rest, e.g. css maps).
  for (const map of maps) {
    if (!claimedMaps.has(map)) {
      const mapName = rel(dir, map);
      const mapRead = await loadMap(map);
      if (!mapRead.ok) {
        reportUnreadableMap(mapName, mapRead);
        continue;
      }
      const parsed = mapRead.parsed;
      if (!parsed.ok) {
        if (markSeen(mapRead.real)) {
          add({
            id: 'map.invalid',
            severity: 'error',
            file: mapName,
            message: `${mapName} is ${parsed.why}.`,
            fix: 'Check the build is not truncating or post-processing the map; rebuild.',
          });
        }
      } else {
        validateMap(map, mapName, parsed.json, mapRead.real);
      }
    }
  }

  function reportUnreadableMap(mapName: string, read: Extract<ReadResult, { ok: false }>): void {
    if (read.tooLarge !== undefined) {
      add({
        id: 'map.too-large',
        severity: 'warning',
        file: mapName,
        message: `${mapName} is ${(read.tooLarge.size / 1024 / 1024).toFixed(1)} MiB (limit checked: ${(maxMapBytes / 1024 / 1024).toFixed(0)} MiB), so it was not read or validated; the upload may be slow or rejected.`,
        fix: 'Split the bundle, strip sourcesContent (`stripSourcesContent`) or exclude vendor chunks; raise --max-map-mb to validate it.',
        details: { bytes: read.tooLarge.size, limit: maxMapBytes },
      });
    } else {
      add({
        id: 'map.unreadable',
        severity: 'error',
        file: mapName,
        message: `${mapName} ${read.reason}, so it cannot be validated or uploaded.`,
        fix: 'Make it a regular file inside the output directory (no symlink, FIFO or device).',
      });
    }
  }

  function validateMap(
    mapPath: string,
    mapName: string,
    json: Record<string, unknown>,
    real: string,
  ): void {
    const first = markSeen(real); // content and structure are the same for every name of one file
    const base = `${real}\0${dirname(mapPath)}`;
    if (seenBases.has(base)) {
      return; // a map shared by several bundles in one directory is validated once
    }
    seenBases.add(base);
    const invalid = (message: string, fix: string, id = 'map.invalid'): void => {
      if (first) {
        add({ id, severity: 'error', file: mapName, message, fix });
      }
    };
    if (json.version !== 3) {
      invalid(
        `${mapName} is not a source map v3 (version is ${JSON.stringify(json.version)}).`,
        'Only version 3 maps are supported; check the bundler/minifier output.',
      );
      return;
    }
    if (typeof json.mappings !== 'string' && !Array.isArray(json.sections)) {
      invalid(
        `${mapName} has neither \`mappings\` nor \`sections\`: it carries no position data, so no frame can be mapped.`,
        'Check the build is not stripping the map; rebuild.',
      );
      return;
    }
    const { sources, content, roots, hasOriginal } = mapSources(json);
    if (sources.length === 0) {
      invalid(
        `${mapName} has no \`sources\`; it can map nothing back to your code.`,
        'Enable full source maps in the bundler (not a stripped / empty map).',
        'map.no-sources',
      );
      return;
    }
    if (!hasOriginal) {
      invalid(
        `${mapName} has no mapping to an original position (its \`mappings\` is empty or holds only generated positions), so no frame can be mapped back to your code.`,
        'Check the build is not stripping the map or minifying without tracking sources; rebuild.',
      );
      return;
    }
    const missingAt = sources.flatMap((_, i) => (typeof content[i] !== 'string' ? [i] : []));
    const missing = missingAt.map((i) => String(sources[i]));
    if (missing.length === 0) {
      if (first) {
        contentFacts.push({
          file: mapName,
          embeddedAll: true,
          message: `${mapName} embeds sourcesContent for all ${sources.length} sources.`,
        });
      }
      return;
    }
    const mapDir = dirname(mapPath);
    const unresolved = missingAt.flatMap((i) => {
      const path = sourcePath(mapDir, roots[i] as string, String(sources[i]), projectRoot);
      return path !== undefined && !existsSync(path) ? [String(sources[i])] : [];
    });
    if (unresolved.length > 0) {
      add({
        id: 'map.sources-unresolvable',
        severity: 'warning',
        file: mapName,
        message: `${mapName} embeds no sourcesContent for ${unresolved.length} of ${sources.length} sources and they are not on disk (${unresolved.slice(0, MAX_LISTED).join(', ')}${unresolved.length > MAX_LISTED ? ', …' : ''}); frames will show names but no source lines.`,
        fix: 'Build with sourcesContent embedded (inlineSources / `sourcesContent: true`), or upload from a machine that still has the sources.',
        details: { unresolved: unresolved.length, total: sources.length },
      });
    } else if (first) {
      contentFacts.push({
        file: mapName,
        embeddedAll: false,
        message: `${mapName} does not embed sourcesContent for ${missing.length} sources, but they are resolvable on disk.`,
        details: { embedded: sources.length - missing.length, total: sources.length },
      });
    }
  }

  // --- aggregate findings -------------------------------------------------------------------------
  // One note per map is useful for a handful of maps and noise for thousands (a 20k-bundle build was 3.6 MB of JSON).
  if (contentFacts.length <= MAX_LISTED * 2) {
    for (const fact of contentFacts) {
      findings.push({
        id: 'map.sources-content',
        severity: 'info',
        file: fact.file,
        message: fact.message,
        ...(fact.details !== undefined ? { details: fact.details } : {}),
      });
    }
  } else {
    const embedded = contentFacts.filter((f) => f.embeddedAll).length;
    findings.push({
      id: 'map.sources-content',
      severity: 'info',
      message: `${contentFacts.length} maps carry no sourcesContent problem: ${embedded} embed it for all sources, ${contentFacts.length - embedded} do not but their sources are resolvable on disk.`,
      details: {
        maps: contentFacts.length,
        embedded,
        resolvableOnDisk: contentFacts.length - embedded,
      },
    });
  }
  const withoutMap = new Set(unstampedWithoutMap);
  if (bundles.length > 0 && unreadable.length === bundles.length) {
    // Nothing was audited: that must not be ignorable into a pass (`--ignore output.unreadable`).
    add({
      id: 'output.no-js',
      severity: 'error',
      message: `None of the ${bundles.length} script(s) under ${dir} could be read, so nothing was checked.`,
      fix: 'Make the scripts regular files that the current user can read, and run the doctor again.',
    });
  }
  if (unreadable.length > 0) {
    add({
      id: 'output.unreadable',
      severity: 'error',
      message: `${unreadable.length} script(s) could not be read (${unreadable.slice(0, MAX_LISTED).join('; ')}${unreadable.length > MAX_LISTED ? '; …' : ''}); they were not checked.`,
      fix: 'Make them regular files under the size limit, or exclude them from the output directory.',
      details: listDetails('files', unreadable),
    });
  }
  for (const name of unstamped) {
    if (!withoutMap.has(name)) {
      add({
        id: 'stamp.missing-debug-id',
        severity: 'error',
        file: name,
        message: `${name} has no debugId comment: crashes from it cannot be matched to a source map.`,
        fix: 'Add the Bugsee plugin (it stamps inside the build) or run `bugsee-cli sourcemaps inject <dir>` after the build.',
      });
    }
  }
  if (unstampedWithoutMap.length > 0) {
    add({
      id: 'stamp.missing-debug-id',
      severity: 'warning',
      message: `${unstampedWithoutMap.length} bundle(s) are not stamped and have no map on disk (${unstampedWithoutMap.slice(0, MAX_LISTED).join(', ')}${unstampedWithoutMap.length > MAX_LISTED ? ', …' : ''}); they will not symbolicate.`,
      fix: 'Emit source maps and stamp the build; ignore for vendor files you do not want symbolicated.',
      details: listDetails('files', unstampedWithoutMap),
    });
  }
  if (noRegistration.length > 0) {
    add({
      id: 'stamp.missing-registration',
      severity: 'error',
      message: `${noRegistration.length} bundle(s) have a debugId comment but no ${REGISTRATION} registration (${noRegistration.slice(0, MAX_LISTED).join(', ')}); the runtime cannot report the id with a crash.`,
      fix: 'Re-stamp with `bugsee-cli sourcemaps inject` (it appends the registration); a hand-added comment is not enough.',
      details: listDetails('files', noRegistration),
    });
  }
  if (stamped > 0 && unstamped.size > 0) {
    add({
      id: 'stamp.mixed',
      severity: 'warning',
      message: `${stamped} bundle(s) are stamped but ${unstamped.size} are not (${[...unstamped].slice(0, MAX_LISTED).join(', ')}${unstamped.size > MAX_LISTED ? ', …' : ''}): a partial stamp usually means a second build output or a late-emitted file was missed.`,
      fix: 'Run the stamp over the whole output directory after the last emit step.',
      details: { stamped, unstamped: unstamped.size },
    });
  }
  for (const [id, entries] of stampedIds) {
    if (entries.length < 2) {
      continue; // hashing is only worth it for an id that appears more than once
    }
    const hashes = new Set<string>();
    for (const entry of entries) {
      const read = await readInside(entry.path, maxBundleBytes, realDir);
      hashes.add(read.ok ? sha(read.bytes) : `unreadable:${entry.path}`);
    }
    if (hashes.size > 1) {
      add({
        id: 'stamp.duplicate-debug-id',
        severity: 'error',
        message: `debugId ${id} appears on ${entries.length} bundles with different contents (${entries.map((e) => e.file).join(', ')}); one will symbolicate with the other's map.`,
        fix: 'Strip the old stamps and re-stamp (a copied or cached stamped file was edited), or clean the output dir before building.',
        details: { debugId: id, files: entries.map((e) => e.file) },
      });
    }
  }
  if (dangling.length > 0) {
    // No map file anywhere and every bundle stamped: the maps were removed on purpose (the plugin's
    // `deleteMaps` after a confirmed upload), so the leftover comment is a note, not a defect to fail on.
    const removedOnPurpose = maps.length === 0 && unstamped.size === 0;
    add({
      id: 'map.pointer-dangling',
      severity: removedOnPurpose ? 'info' : 'warning',
      message: `${dangling.length} bundle(s) point at a source map that is not on disk (${dangling.slice(0, MAX_LISTED).join(', ')}${dangling.length > MAX_LISTED ? ', …' : ''}); browsers request it and get a 404${removedOnPurpose ? ' (harmless for symbolication: the maps were removed and the bundles are stamped)' : ''}.`,
      fix: 'Emit hidden source maps (sourcemap: "hidden") so no pointer is written, or keep the maps until deploy.',
      details: listDetails('pointers', dangling),
    });
  }
  if (outsideDir.length > 0) {
    add({
      id: 'map.pointer-outside-dir',
      severity: 'warning',
      message: `${outsideDir.length} bundle(s) point at a source map outside ${dir} (${outsideDir.slice(0, MAX_LISTED).join(', ')}${outsideDir.length > MAX_LISTED ? ', …' : ''}); it was not read and cannot be paired.`,
      fix: 'Emit the map inside the output directory, or check the sourceMappingURL.',
      details: listDetails('pointers', outsideDir),
    });
  }
  if (hidden.length > 0) {
    findings.push({
      id: 'map.hidden',
      severity: 'info',
      message: `${hidden.length} bundle(s) have a map but no sourceMappingURL comment (hidden maps): good for privacy.`,
      details: listDetails('files', hidden),
    });
  }
  if (inline.size > 0) {
    add({
      id: 'map.inline',
      severity: 'error',
      message: `${inline.size} bundle(s) carry an inline (data:) source map (${[...inline].slice(0, MAX_LISTED).join(', ')}); there is no .map file to upload and the map ships to every visitor.`,
      fix: 'Switch to external hidden maps (Vite `build.sourcemap: "hidden"`, webpack `devtool: "hidden-source-map"`, esbuild `sourcemap: "external"`).',
      details: listDetails('files', [...inline]),
    });
  }
  if (devBundles.length > 0) {
    add({
      id: 'build.dev-bundle',
      severity: 'warning',
      message: `${devBundles.length} bundle(s) look like a development build (webpack eval-style sourceURL markers: ${devBundles.slice(0, MAX_LISTED).join(', ')}); eval maps are not uploadable and bundles are unminified.`,
      fix: 'Build in production mode (mode: "production", NODE_ENV=production) before uploading.',
      details: listDetails('files', devBundles),
    });
  }
  if (maps.length > 0) {
    add({
      id: 'map.public-leftover',
      severity: options.deployed === true ? 'warning' : 'info',
      message: `${maps.length} .map file(s) are on disk in ${dir}; if this directory is deployed they are served publicly and expose your source.`,
      fix: 'Keep `deleteMaps` on (default) so maps are removed after a confirmed upload, or emit hidden maps and exclude *.map from deploys. Run with --deployed on the directory you actually serve to make this a warning.',
      details: { count: maps.length, files: maps.slice(0, MAX_LISTED).map((m) => rel(dir, m)) },
    });
  }

  // --- SRI ------------------------------------------------------------------------------------------
  // A page named by `--exclude` is skipped BEFORE it is read: it contributes no pins (and cannot claim one first).
  const sriScan = await findSriProtectedScriptsDetailed(
    dir,
    MAX_HTML_BYTES,
    walked.fenced,
    isExcluded,
  );
  const allUnreadable = [
    ...new Set([...walked.unreadable, ...sriScan.unreadableDirs.map((d) => rel(dir, d) || '.')]),
  ].sort();
  // `--exclude vendor/**` (or `vendor/`) names a directory too.
  // Excluded only if the patterns would hide EVERY kind of file the doctor looks at inside it (a probe of each, deep
  // down, plus one no extension glob can target): never broader than for a readable directory.
  const excludedDirs = allUnreadable.filter((d) =>
    DIR_PROBES.every((probe) => isExcludedName(`${d}/${probe}`)),
  );
  const unreadableDirs = allUnreadable.filter((d) => !excludedDirs.includes(d));
  if (excludedDirs.length > 0) {
    add({
      id: 'output.excluded',
      severity: 'info',
      message: `${excludedDirs.length} unreadable director${excludedDirs.length === 1 ? 'y' : 'ies'} matched --exclude and ${excludedDirs.length === 1 ? 'was' : 'were'} not checked (${excludedDirs.slice(0, MAX_LISTED).join(', ')}${excludedDirs.length > MAX_LISTED ? ', …' : ''}).`,
      details: listDetails('directories', excludedDirs),
    });
  }
  if (unreadableDirs.length > 0) {
    // Scripts, maps and pages in them were NOT checked: a pass would be false.
    add({
      id: 'output.dir-unreadable',
      severity: 'error',
      message: `${unreadableDirs.length} director${unreadableDirs.length === 1 ? 'y' : 'ies'} could not be listed (unreadable, or a symlink that leaves the output directory), so nothing in ${unreadableDirs.length === 1 ? 'it was' : 'them was'} checked (${unreadableDirs.slice(0, MAX_LISTED).join(', ')}${unreadableDirs.length > MAX_LISTED ? ', …' : ''}).`,
      fix: 'Make the directories readable by the user running the doctor (a build run as root in a container, then checked as another user, is the usual cause) and run it again.',
      details: listDetails('directories', unreadableDirs),
    });
  }
  const pinned = sriScan.scripts.filter((pin) => !isExcluded(pin.script));
  const unmatched = excludeGlobs.filter((_, i) => !matchedPatterns.has(i));
  if (unmatched.length > 0) {
    add({
      id: 'output.exclude-unmatched',
      severity: 'info',
      message: `${unmatched.length} --exclude pattern(s) matched no file (${unmatched.join(', ')}); patterns are relative to ${dir} (Vite copies publicDir to its ROOT: write sw.js, not public/sw.js).`,
      details: { patterns: unmatched },
    });
  }
  if (sriScan.skippedPages.length > 0) {
    const names = sriScan.skippedPages.map((page) => rel(dir, page.html));
    add({
      id: 'sri.html-skipped',
      severity: 'warning',
      message: `${names.length} page(s) are larger than ${MAX_HTML_BYTES / 1024 / 1024} MiB and were not scanned for integrity pins (${names.slice(0, MAX_LISTED).join(', ')}${names.length > MAX_LISTED ? ', …' : ''}); a script they pin would not be noticed.`,
      fix: 'A real page is a few KB; check that this is not a data file named .html. Stamping still sees pins in such a page.',
      details: listDetails('files', names),
    });
  }
  if (sriScan.unreadablePages.length > 0) {
    const names = sriScan.unreadablePages.map((page) => rel(dir, page));
    add({
      id: 'sri.html-skipped',
      severity: 'warning',
      message: `${names.length} page(s) could not be read and were not scanned for integrity pins (${names.slice(0, MAX_LISTED).join(', ')}${names.length > MAX_LISTED ? ', …' : ''}); a script they pin would not be noticed.`,
      fix: 'Make the pages readable and run the doctor again.',
      details: listDetails('files', names),
    });
  }
  if (pinned.length > 0) {
    const unstampedPinned: typeof pinned = [];
    const mismatches: typeof pinned = [];
    const pinsUnread: string[] = [];
    for (const p of pinned) {
      // The same guarded reader as every other read (symlinks resolved only if they stay inside the directory,
      // regular files of bounded size only). The bytes read here are also what the integrity check judges.
      const read = await readInside(p.script, maxBundleBytes, realDir);
      if (!read.ok) {
        // A pin to a file that is not there is stale, not something stamping would break; anything else (it
        // leads outside, is a FIFO, is too large) is a pin we could not judge, and that is said.
        if (!read.reason.includes('(ENOENT)')) {
          pinsUnread.push(`${rel(dir, p.script)} ${read.reason}`);
        }
        continue;
      }
      if (!passesIntegrity(p.integrity, read.bytes)) {
        mismatches.push(p);
      }
      if (readDebugId(read.bytes.toString('utf8')) === undefined) {
        unstampedPinned.push(p);
      }
    }
    if (pinsUnread.length > 0) {
      add({
        id: 'sri.pin-unreadable',
        severity: 'warning',
        message: `${pinsUnread.length} script(s) pinned by an integrity hash could not be checked (${pinsUnread.slice(0, MAX_LISTED).join('; ')}${pinsUnread.length > MAX_LISTED ? '; …' : ''}).`,
        fix: 'Make the pinned scripts regular files inside the output directory.',
        details: listDetails('scripts', pinsUnread),
      });
    }
    if (unstampedPinned.length > 0) {
      add({
        id: 'sri.unstamped-hazard',
        severity: 'warning',
        message: `${unstampedPinned.length} script(s) are pinned by an integrity hash in ${rel(dir, unstampedPinned[0]?.html ?? dir)} and are not stamped; stamping them AFTER the page was written would make the browser block them.`,
        fix: 'Use the Bugsee plugin (stamps before the SRI plugin hashes; list it first), or re-generate the integrity hashes after `sourcemaps inject`.',
        details: { scripts: unstampedPinned.map((p) => rel(dir, p.script)) },
      });
    }
    if (mismatches.length > 0) {
      add({
        id: 'sri.mismatch',
        severity: 'error',
        message: `${mismatches.length} script(s) no longer match the integrity hash pinning them (${mismatches
          .slice(0, MAX_LISTED)
          .map((m) => rel(dir, m.script))
          .join(', ')}); the browser refuses to run them and the page loads nothing.`,
        fix: 'Something rewrote the files after the hashes were computed (usually a post-build stamp). Stamp first, hash last.',
        details: { scripts: mismatches.map((m) => rel(dir, m.script)) },
      });
    }
  }
  const manifests = await manifestsWithIntegrity(dir, maxMapBytes, realDir);
  if (manifests.length > 0) {
    const names = manifests.map((p) => rel(dir, p));
    add({
      id: 'sri.manifest-hashes',
      severity: 'warning',
      message: `${names.join(', ')} mention integrity hashes the doctor cannot tie to a script; if they pin these bundles, stamping them afterwards breaks the page.`,
      fix: 'Check whether the manifest pins hashes of these files; if so make stamping happen before they are computed, or regenerate them. (A page outside this directory is not read: run the doctor on the directory that holds it.)',
      details: { files: names },
    });
  }

  // --- environment ----------------------------------------------------------------------------------
  if (options.skipEnv !== true) {
    const root = projectRoot;
    const fromFile = loadBuildPluginEnv(root);
    const merged = mergeBuildPluginEnv(env, fromFile.values);
    const optionToken = options.appToken?.trim() ?? '';
    const envToken = merged.BUGSEE_APP_TOKEN?.trim() ?? '';
    if (optionToken === '' && envToken === '') {
      add({
        id: 'env.token-missing',
        severity: 'warning',
        message:
          'No Bugsee app token is resolvable (BUGSEE_APP_TOKEN, .env.bugsee-build-plugin, or the appToken option): the bundler plugin is disabled and uploads nothing (fine if you upload with bugsee-cli by hand).' +
          (fromFile.problem !== undefined ? ` ${fromFile.problem}` : ''),
        fix: 'Set BUGSEE_APP_TOKEN in the build environment or in .env.bugsee-build-plugin next to your project.',
      });
    } else {
      // Where it came from, never the value: the same precedence the plugin applies (option, env, file).
      const source =
        optionToken !== ''
          ? ('option' as const)
          : (env.BUGSEE_APP_TOKEN?.trim() ?? '') !== ''
            ? ('env' as const)
            : ('env-file' as const);
      const label = {
        option: 'the appToken option',
        env: 'the BUGSEE_APP_TOKEN environment variable',
        'env-file': '.env.bugsee-build-plugin',
      }[source];
      findings.push({
        id: 'env.token-source',
        severity: 'info',
        message: `The app token comes from ${label}.`,
        details: { source },
      });
    }
    const identity = findAppIdentity(
      { appVersion: options.appVersion, appBuild: options.appBuild },
      merged,
      {},
      root,
    );
    if (identity.version === undefined) {
      add({
        id: 'env.version-unresolved',
        severity: 'warning',
        message: `No app version is resolvable (BUGSEE_APP_VERSION or a package.json version at or above ${root}); the upload is labelled 0.0.0.`,
        fix: 'Set BUGSEE_APP_VERSION, or pass --project-root to the directory holding package.json.',
      });
    }
    if (identity.build === undefined) {
      add({
        id: 'env.build-unresolved',
        severity: 'info',
        message:
          'No app build id is resolvable (BUGSEE_APP_BUILD or a CI commit variable); the build is labelled 0.',
        fix: 'Set BUGSEE_APP_BUILD (e.g. the commit SHA) so builds can be told apart.',
      });
    }
    if (merged.NODE_ENV === 'development') {
      add({
        id: 'env.node-env-development',
        severity: 'warning',
        message:
          'NODE_ENV is "development": the Bugsee plugins skip the upload for development builds (unless uploadInDevelopment is set).',
        fix: 'Build with NODE_ENV=production for the build you deploy.',
      });
    }
  }

  // A check with no input did not run: no scripts means no stamp / pointer checks, no maps no map-content checks.
  const needsBundles = (id: string): boolean => id.startsWith('stamp.') || NEEDS_BUNDLES.has(id);
  const passed = DOCTOR_CHECK_IDS.filter(
    (id) =>
      !failed.has(id) &&
      !INFO_ONLY.has(id) &&
      !(options.skipEnv === true && id.startsWith('env.')) &&
      !(bundles.length === 0 && needsBundles(id)) &&
      !(maps.length === 0 && NEEDS_MAPS.has(id)),
  );
  return finish(dir, findings, bundles.length, maps.length, passed, options.ignore);
}

const NEEDS_BUNDLES: ReadonlySet<string> = new Set([
  'build.dev-bundle',
  'map.pointer-dangling',
  'map.pointer-outside-dir',
  'map.inline',
]);
const NEEDS_MAPS: ReadonlySet<string> = new Set([
  'map.invalid',
  'map.no-sources',
  'map.sources-unresolvable',
  'map.too-large',
  'map.unreadable',
]);

/** Checks that only ever produce an `info` finding: they are not "passed", they are facts. */
const INFO_ONLY: ReadonlySet<string> = new Set([
  'output.excluded',
  'output.exclude-unmatched',
  'output.walk-fenced',
  'map.hidden',
  'map.sources-content',
  'env.token-source',
  'doctor.internal-error',
]);

function finish(
  dir: string,
  findings: DoctorFinding[],
  bundles: number,
  maps: number,
  passed: readonly string[],
  ignore: readonly string[] = [],
): DoctorReport {
  ignore = ignore.filter((id) => !NON_IGNORABLE_CHECK_IDS.has(id));
  const dropped = ignore.filter((id) => findings.some((f) => f.id === id));
  if (dropped.length > 0) {
    findings = findings.filter((f) => !ignore.includes(f.id));
  }
  const count = (severity: DoctorSeverity): number =>
    findings.filter((f) => f.severity === severity).length;
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    tool: 'bugsee-sourcemaps-doctor',
    dir,
    summary: {
      errors: count('error'),
      warnings: count('warning'),
      infos: count('info'),
      bundles,
      maps,
    },
    passed: passed.filter((id) => !ignore.includes(id)),
    findings,
    ...(dropped.length > 0 ? { ignored: [...new Set(dropped)] } : {}),
  };
}

/** 0 clean, 2 errors, 1 warnings only under `strict`. */
export function doctorExitCode(report: DoctorReport, strict = false): 0 | 1 | 2 {
  if (report.summary.errors > 0) {
    return 2;
  }
  return strict && report.summary.warnings > 0 ? 1 : 0;
}

const MARK: Record<DoctorSeverity, string> = {
  error: 'ERROR  ',
  warning: 'WARN   ',
  info: 'info   ',
};

/** The human rendering. Stable enough to read; machines should use the JSON report. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Bugsee source-map doctor: ${report.dir}`,
    `${report.summary.bundles} bundle(s), ${report.summary.maps} map(s): ${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ${report.summary.infos} note(s)`,
    '',
  ];
  const order: DoctorSeverity[] = ['error', 'warning', 'info'];
  for (const severity of order) {
    for (const finding of report.findings.filter((f) => f.severity === severity)) {
      lines.push(`${MARK[severity]}[${finding.id}] ${finding.message}`);
      if (finding.fix !== undefined) {
        lines.push(`        fix: ${finding.fix}`);
      }
    }
  }
  if (report.findings.length === 0) {
    lines.push('No problems found.');
  }
  return lines.join('\n');
}
