// `sourcemaps doctor` — the OFFLINE half. Reads a build output directory exactly as it sits on disk and says
// why a crash from it would (not) symbolicate, without a network call, a token, or a backend.
//
// Every finding has a stable check ID, a severity, a human message and a fix hint, and the report has one
// versioned JSON shape (`DoctorReport`) that the Rust `bugsee-cli sourcemaps doctor` is specified to emit
// too (see the design hand-off), so a CI step can consume either. Pure reads: nothing is written or deleted.
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import nodePath, { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAppIdentity } from './app-identity';
import { readDebugId } from './debug-ids';
import { loadBuildPluginEnv, mergeBuildPluginEnv } from './env-file';
import type { EnvRecord } from './run-cli';
import { findSriProtectedScripts, passesIntegrity } from './sri';
import { isProjectRootOrAbove, MAX_WALK_DEPTH, NEVER_WALK } from './stamp-files';
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
}

const DEFAULT_MAX_MAP_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
/** Files read at once: bounds open handles and the bytes held in memory. */
const READ_CONCURRENCY = 16;
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
 * Every script and map under `root`. An output directory is walked in full (Rollup `preserveModules` writes
 * `dist/src/*.js`; a build may emit `dist/test/`), skipping only `node_modules` and `.git`; the fence on
 * `src`/`test`/dot-directories and the depth cap apply ONLY when `root` is the project root or above, where
 * they keep the walk out of the source tree. Iterative, and never spreads a result list (a directory with
 * 100k files must not overflow the call stack).
 */
export async function walk(root: string): Promise<string[]> {
  const fenced = await isProjectRootOrAbove(root);
  const found: string[] = [];
  const pending: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (fenced && next.depth > MAX_WALK_DEPTH) {
      continue;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(next.dir, entry.name);
      if (entry.isDirectory()) {
        const skip =
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          (fenced && (NEVER_WALK.has(entry.name) || entry.name.startsWith('.')));
        if (!skip) {
          pending.push({ dir: full, depth: next.depth + 1 });
        }
      } else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        (BUNDLE.test(entry.name) || MAP.test(entry.name))
      ) {
        found.push(full);
      }
    }
  }
  return found.sort();
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
  if (/^file:\/\//i.test(path)) {
    try {
      return fileURLToPath(path, api === nodePath.win32 ? { windows: true } : undefined);
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
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

type ReadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: string; tooLarge?: { size: number } };

/**
 * Read a REGULAR file of at most `limit` bytes. `lstat` first, so a FIFO, a device (`/dev/zero`) or a symlink
 * is never opened (callers pass only paths that cannot run through a symlinked directory: the walk does not
 * descend into one, and a pointer target is `realpath`-checked against the output directory first), and the size is judged before a single byte is read. A failure is a value, not a throw.
 */
async function readRegular(path: string, limit: number): Promise<ReadResult> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) {
      return {
        ok: false,
        reason: info.isSymbolicLink() ? 'is a symbolic link' : 'is not a regular file',
      };
    }
    if (info.size > limit) {
      return { ok: false, reason: 'is too large to read', tooLarge: { size: info.size } };
    }
    return { ok: true, bytes: await readFile(path) };
  } catch (error) {
    return {
      ok: false,
      reason: `could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
    };
  }
}

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
async function manifestsWithIntegrity(dir: string, limit: number): Promise<string[]> {
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
    const read = await readRegular(join(dir, name), limit);
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
 * never writes; reads maps and bundles in full, but only once each.
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
  const files = await walk(dir);
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

  const mapSet = new Set(maps);
  const validated = new Set<string>();
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
  const reads = new Map<string, ReadResult>();
  const readBatch = async (batch: readonly string[]): Promise<void> => {
    const results = await Promise.all(batch.map((path) => readRegular(path, maxBundleBytes)));
    batch.forEach((path, i) => {
      reads.set(path, results[i] as ReadResult);
    });
  };

  for (let at = 0; at < bundles.length; at++) {
    if (at % READ_CONCURRENCY === 0) {
      reads.clear();
      await readBatch(bundles.slice(at, at + READ_CONCURRENCY));
    }
    const bundle = bundles[at] as string;
    const name = rel(dir, bundle);
    const read = reads.get(bundle) as ReadResult;
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
        const target = localPointerTarget(bundle, code, nodePath);
        if (target !== undefined) {
          if (!isInside(dir, target)) {
            // Never read it: a pointer can name `/dev/zero`, a FIFO or someone else's file.
            outsideDir.push(`${name} -> ${pointer}`);
          } else if (mapSet.has(target)) {
            mapPath = target;
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
      const mapRead = await readRegular(mapPath, maxMapBytes);
      if (!mapRead.ok) {
        reportUnreadableMap(mapName, mapRead);
        continue;
      }
      const parsed = parseMap(mapRead.bytes.toString('utf8'));
      if (!parsed.ok) {
        add({
          id: 'map.invalid',
          severity: 'error',
          file: mapName,
          message: `${mapName} is ${parsed.why}, so it cannot be uploaded or used to symbolicate.`,
          fix: 'Check the build is not truncating or post-processing the map; rebuild.',
        });
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
      validateMap(mapPath, mapName, parsed.json);
    }
  }

  // Maps nothing points at (hidden maps of bundles are claimed above; this is the rest, e.g. css maps).
  for (const map of maps) {
    if (!claimedMaps.has(map)) {
      const mapName = rel(dir, map);
      const mapRead = await readRegular(map, maxMapBytes);
      if (!mapRead.ok) {
        reportUnreadableMap(mapName, mapRead);
        continue;
      }
      const parsed = parseMap(mapRead.bytes.toString('utf8'));
      if (!parsed.ok) {
        add({
          id: 'map.invalid',
          severity: 'error',
          file: mapName,
          message: `${mapName} is ${parsed.why}.`,
          fix: 'Check the build is not truncating or post-processing the map; rebuild.',
        });
      } else {
        validateMap(map, mapName, parsed.json);
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

  function validateMap(mapPath: string, mapName: string, json: Record<string, unknown>): void {
    if (validated.has(mapPath)) {
      return; // a map shared by several bundles is validated once
    }
    validated.add(mapPath);
    if (json.version !== 3) {
      add({
        id: 'map.invalid',
        severity: 'error',
        file: mapName,
        message: `${mapName} is not a source map v3 (version is ${JSON.stringify(json.version)}).`,
        fix: 'Only version 3 maps are supported; check the bundler/minifier output.',
      });
      return;
    }
    const sources = Array.isArray(json.sources) ? (json.sources as unknown[]) : undefined;
    if (sources === undefined || sources.length === 0) {
      add({
        id: 'map.no-sources',
        severity: 'error',
        file: mapName,
        message: `${mapName} has no \`sources\`; it can map nothing back to your code.`,
        fix: 'Enable full source maps in the bundler (not a stripped / empty map).',
      });
      return;
    }
    const content = Array.isArray(json.sourcesContent) ? (json.sourcesContent as unknown[]) : [];
    const missing = sources.filter((_, i) => typeof content[i] !== 'string').map(String);
    if (missing.length === 0) {
      findings.push({
        id: 'map.sources-content',
        severity: 'info',
        file: mapName,
        message: `${mapName} embeds sourcesContent for all ${sources.length} sources.`,
      });
      return;
    }
    const sourceRoot = typeof json.sourceRoot === 'string' ? json.sourceRoot : '';
    const mapDir = dirname(mapPath);
    const unresolved = missing.filter((source) => {
      const path = sourcePath(mapDir, sourceRoot, source, projectRoot);
      return path !== undefined && !existsSync(path);
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
    } else {
      findings.push({
        id: 'map.sources-content',
        severity: 'info',
        file: mapName,
        message: `${mapName} does not embed sourcesContent for ${missing.length} sources, but they are resolvable on disk.`,
        details: { embedded: sources.length - missing.length, total: sources.length },
      });
    }
  }

  // --- aggregate findings -------------------------------------------------------------------------
  const withoutMap = new Set(unstampedWithoutMap);
  if (unreadable.length > 0) {
    add({
      id: 'output.unreadable',
      severity: 'error',
      message: `${unreadable.length} script(s) could not be read (${unreadable.slice(0, MAX_LISTED).join('; ')}${unreadable.length > MAX_LISTED ? '; …' : ''}); they were not checked.`,
      fix: 'Make them regular files under the size limit, or exclude them from the output directory.',
      details: { files: unreadable },
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
      details: { files: unstampedWithoutMap },
    });
  }
  if (noRegistration.length > 0) {
    add({
      id: 'stamp.missing-registration',
      severity: 'error',
      message: `${noRegistration.length} bundle(s) have a debugId comment but no ${REGISTRATION} registration (${noRegistration.slice(0, MAX_LISTED).join(', ')}); the runtime cannot report the id with a crash.`,
      fix: 'Re-stamp with `bugsee-cli sourcemaps inject` (it appends the registration); a hand-added comment is not enough.',
      details: { files: noRegistration },
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
      const read = await readRegular(entry.path, maxBundleBytes);
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
      details: { pointers: dangling },
    });
  }
  if (outsideDir.length > 0) {
    add({
      id: 'map.pointer-outside-dir',
      severity: 'warning',
      message: `${outsideDir.length} bundle(s) point at a source map outside ${dir} (${outsideDir.slice(0, MAX_LISTED).join(', ')}${outsideDir.length > MAX_LISTED ? ', …' : ''}); it was not read and cannot be paired.`,
      fix: 'Emit the map inside the output directory, or check the sourceMappingURL.',
      details: { pointers: outsideDir },
    });
  }
  if (hidden.length > 0) {
    findings.push({
      id: 'map.hidden',
      severity: 'info',
      message: `${hidden.length} bundle(s) have a map but no sourceMappingURL comment (hidden maps): good for privacy.`,
      details: { files: hidden },
    });
  }
  if (inline.size > 0) {
    add({
      id: 'map.inline',
      severity: 'error',
      message: `${inline.size} bundle(s) carry an inline (data:) source map (${[...inline].slice(0, MAX_LISTED).join(', ')}); there is no .map file to upload and the map ships to every visitor.`,
      fix: 'Switch to external hidden maps (Vite `build.sourcemap: "hidden"`, webpack `devtool: "hidden-source-map"`, esbuild `sourcemap: "external"`).',
      details: { files: [...inline] },
    });
  }
  if (devBundles.length > 0) {
    add({
      id: 'build.dev-bundle',
      severity: 'warning',
      message: `${devBundles.length} bundle(s) look like a development build (webpack eval-style sourceURL markers: ${devBundles.slice(0, MAX_LISTED).join(', ')}); eval maps are not uploadable and bundles are unminified.`,
      fix: 'Build in production mode (mode: "production", NODE_ENV=production) before uploading.',
      details: { files: devBundles },
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
  const pinned = await findSriProtectedScripts(dir);
  if (pinned.length > 0) {
    const unstampedPinned: typeof pinned = [];
    const mismatches: typeof pinned = [];
    for (const p of pinned) {
      // The same guards as every other read: not through a symlinked directory that leads out, and only a
      // regular file of bounded size (a FIFO or `/dev/zero` is never opened). The bytes read here are also
      // what the integrity check judges, so nothing is read twice.
      const real = await realpath(p.script).catch(() => undefined);
      if (real === undefined || !isInside(realDir, real)) {
        continue;
      }
      const read = await readRegular(p.script, maxBundleBytes);
      if (!read.ok) {
        continue; // a pin to a file that is not there is stale, not something stamping would break
      }
      if (!passesIntegrity(p.integrity, read.bytes)) {
        mismatches.push(p);
      }
      if (readDebugId(read.bytes.toString('utf8')) === undefined) {
        unstampedPinned.push(p);
      }
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
  const manifests = await manifestsWithIntegrity(dir, maxMapBytes);
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

  const passed = DOCTOR_CHECK_IDS.filter(
    (id) =>
      !failed.has(id) && !INFO_ONLY.has(id) && !(options.skipEnv === true && id.startsWith('env.')),
  );
  return finish(dir, findings, bundles.length, maps.length, passed, options.ignore);
}

/** Checks that only ever produce an `info` finding: they are not "passed", they are facts. */
const INFO_ONLY: ReadonlySet<string> = new Set([
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
