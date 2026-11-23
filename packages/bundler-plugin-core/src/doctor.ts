// `sourcemaps doctor` — the OFFLINE half. Reads a build output directory exactly as it sits on disk and says
// why a crash from it would (not) symbolicate, without a network call, a token, or a backend.
//
// Every finding has a stable check ID, a severity, a human message and a fix hint, and the report has one
// versioned JSON shape (`DoctorReport`) that the Rust `bugsee-cli sourcemaps doctor` is specified to emit
// too (see the design hand-off), so a CI step can consume either. Pure reads: nothing is written or deleted.
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { findAppIdentity } from './app-identity';
import { readDebugId } from './debug-ids';
import { loadBuildPluginEnv, mergeBuildPluginEnv } from './env-file';
import type { EnvRecord } from './run-cli';
import { findIntegrityMismatches, findSriProtectedScripts } from './sri';
import { MAX_WALK_DEPTH, NEVER_WALK } from './stamp-files';

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
}

const DEFAULT_MAX_MAP_BYTES = 50 * 1024 * 1024;
const BUNDLE = /\.[cm]?js$/;
const MAP = /\.map$/;
/** The global the runtime stub writes the id into (`@bugsee/browser` reads it at crash time). */
const REGISTRATION = '_bugseeDebugIds';
const MAX_LISTED = 5;

/** Every ID the doctor can emit, in report order. Exported so docs / the Rust port can be checked against it. */
export const DOCTOR_CHECK_IDS = [
  'output.dir-missing',
  'output.no-js',
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
  'map.public-leftover',
  'sri.unstamped-hazard',
  'sri.mismatch',
  'sri.outside-dir',
  'build.dev-bundle',
  'env.token-missing',
  'env.version-unresolved',
  'env.build-unresolved',
  'env.node-env-development',
] as const;
export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

const posix = (path: string): string => path.split('\\').join('/');

/** `bundle.js.map` -> the same name as written in the report; always relative to `dir`. */
const rel = (dir: string, path: string): string => posix(relative(dir, path));

async function walk(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NEVER_WALK.has(entry.name) && !entry.name.startsWith('.')) {
        found.push(...(await walk(full, depth + 1)));
      }
    } else if (entry.isFile() && (BUNDLE.test(entry.name) || MAP.test(entry.name))) {
      found.push(full);
    }
  }
  return found.sort();
}

/** The LAST `//# sourceMappingURL=` value a debugger honours. */
function lastPointer(code: string): string | undefined {
  let last: string | undefined;
  for (const match of code.matchAll(/^[ \t]*\/\/[#@][ \t]*sourceMappingURL=(\S*)[ \t]*$/gm)) {
    last = match[1];
  }
  return last;
}

interface ParsedMap {
  ok: true;
  json: Record<string, unknown>;
  debugId: string | undefined;
}

function parseMap(text: string): ParsedMap | { ok: false; why: string } {
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

/** Resolve a map `sources` entry against the map's directory and `sourceRoot`, as a debugger would. */
function sourcePath(mapDir: string, sourceRoot: string, source: string): string | undefined {
  let path = source;
  if (/^file:\/\//.test(path)) {
    path = decodeURIComponent(path.replace(/^file:\/\/(?=\/)/, '').replace(/^file:\/\//, ''));
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    // `webpack://app/./src/x.ts` and friends: the scheme/namespace is not a directory; drop it.
    path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, '');
  }
  if (VIRTUAL_SOURCE.test(path) || path === '') {
    return undefined;
  }
  return isAbsolute(path) ? path : resolve(mapDir, sourceRoot, path);
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Files in `dir` and its parent that look like a manifest / page and mention integrity hashes. */
async function integrityOutsideDir(dir: string): Promise<string[]> {
  const hits: string[] = [];
  for (const base of [dir, dirname(dir)]) {
    let names: string[];
    try {
      names = await readdir(base);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const inDir = base === dir;
      // HTML inside the dir is the SRI check's own business; a manifest anywhere is not.
      const candidate = inDir
        ? /manifest.*\.json$/i.test(name)
        : /\.html?$|manifest.*\.json$/i.test(name);
      if (!candidate) {
        continue;
      }
      try {
        const text = await readFile(join(base, name), 'utf8');
        if (/\bintegrity\b|["'](sha(256|384|512))-[A-Za-z0-9+/=]{20,}/i.test(text)) {
          hits.push(join(base, name));
        }
      } catch {
        // unreadable: nothing to say about it
      }
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
  const dir = resolve(dirInput);
  const findings: DoctorFinding[] = [];
  const failed = new Set<string>();
  const add = (finding: DoctorFinding): void => {
    findings.push(finding);
    failed.add(finding.id);
  };
  const env = options.env ?? (process.env as EnvRecord);
  const maxMapBytes = options.maxMapBytes ?? DEFAULT_MAX_MAP_BYTES;

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
    return finish(dir, findings, 0, 0, []);
  }

  const files = await walk(dir);
  const bundles = files.filter((f) => BUNDLE.test(f));
  const maps = files.filter((f) => MAP.test(f));
  if (bundles.length === 0) {
    add({
      id: 'output.no-js',
      severity: 'error',
      message: `No .js/.cjs/.mjs files found under ${dir} (node_modules, src, test and dot-directories are not searched).`,
      fix: 'Point the doctor at the bundler output directory, not the project root or a source tree.',
    });
  }

  const mapSet = new Set(maps);
  const claimedMaps = new Set<string>();
  const stampedIds = new Map<string, Array<{ file: string; hash: string }>>();
  let stamped = 0;
  const unstamped: string[] = [];
  const unstampedWithoutMap: string[] = [];
  const noRegistration: string[] = [];
  const dangling: string[] = [];
  const devBundles: string[] = [];
  const inline: string[] = [];
  const hidden: string[] = [];
  const bundleIds = new Map<string, string | undefined>();

  for (const bundle of bundles) {
    const name = rel(dir, bundle);
    const bytes = await readFile(bundle);
    const code = bytes.toString('utf8');
    const id = readDebugId(code);
    bundleIds.set(bundle, id);

    if (/\/\/# sourceURL=webpack-internal:\/\/\/|webpack-internal:\/\/\//.test(code)) {
      devBundles.push(name);
    }

    // Which map belongs to this bundle: the one its pointer names, else the sibling `<bundle>.map`.
    const pointer = lastPointer(code);
    let mapPath: string | undefined;
    if (pointer !== undefined && pointer !== '') {
      if (/^data:/i.test(pointer)) {
        inline.push(name);
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(pointer) && !pointer.startsWith('//')) {
        const target = resolve(dirname(bundle), decodeURIComponent(pointer.split(/[?#]/)[0] ?? ''));
        if (mapSet.has(target) || existsSync(target)) {
          mapPath = target;
        } else {
          dangling.push(`${name} -> ${pointer}`);
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
      unstamped.push(name);
      if (mapPath === undefined && !inline.includes(name)) {
        unstampedWithoutMap.push(name);
      }
    } else {
      stamped++;
      const list = stampedIds.get(id) ?? [];
      list.push({ file: name, hash: sha(bytes) });
      stampedIds.set(id, list);
      if (!code.includes(REGISTRATION)) {
        noRegistration.push(name);
      }
    }

    if (mapPath !== undefined) {
      claimedMaps.add(mapPath);
      const mapName = rel(dir, mapPath);
      let mapBytes: Buffer;
      try {
        mapBytes = await readFile(mapPath);
      } catch {
        continue;
      }
      const parsed = parseMap(mapBytes.toString('utf8'));
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
        unstamped.splice(unstamped.indexOf(name), 1);
      }
      validateMap(mapPath, mapName, mapBytes.length, parsed.json);
    }
  }

  // Maps nothing points at (hidden maps of bundles are claimed above; this is the rest, e.g. css maps).
  for (const map of maps) {
    if (!claimedMaps.has(map)) {
      const mapName = rel(dir, map);
      try {
        const bytes = await readFile(map);
        const parsed = parseMap(bytes.toString('utf8'));
        if (!parsed.ok) {
          add({
            id: 'map.invalid',
            severity: 'error',
            file: mapName,
            message: `${mapName} is ${parsed.why}.`,
            fix: 'Check the build is not truncating or post-processing the map; rebuild.',
          });
        } else {
          validateMap(map, mapName, bytes.length, parsed.json);
        }
      } catch {
        // unreadable: skip
      }
    }
  }

  function validateMap(
    mapPath: string,
    mapName: string,
    size: number,
    json: Record<string, unknown>,
  ): void {
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
    if (size > maxMapBytes) {
      add({
        id: 'map.too-large',
        severity: 'warning',
        file: mapName,
        message: `${mapName} is ${(size / 1024 / 1024).toFixed(1)} MiB (limit checked: ${(maxMapBytes / 1024 / 1024).toFixed(0)} MiB); the upload may be slow or rejected.`,
        fix: 'Split the bundle, strip sourcesContent (`stripSourcesContent`) or exclude vendor chunks.',
        details: { bytes: size, limit: maxMapBytes },
      });
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
      const path = sourcePath(mapDir, sourceRoot, source);
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
  for (const name of unstamped) {
    const hasMap = !unstampedWithoutMap.includes(name);
    if (hasMap || inline.includes(name)) {
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
  if (stamped > 0 && unstamped.length > 0) {
    add({
      id: 'stamp.mixed',
      severity: 'warning',
      message: `${stamped} bundle(s) are stamped but ${unstamped.length} are not (${unstamped.slice(0, MAX_LISTED).join(', ')}${unstamped.length > MAX_LISTED ? ', …' : ''}): a partial stamp usually means a second build output or a late-emitted file was missed.`,
      fix: 'Run the stamp over the whole output directory after the last emit step.',
      details: { stamped, unstamped: unstamped.length },
    });
  }
  for (const [id, entries] of stampedIds) {
    if (new Set(entries.map((e) => e.hash)).size > 1) {
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
    add({
      id: 'map.pointer-dangling',
      severity: 'warning',
      message: `${dangling.length} bundle(s) point at a source map that is not on disk (${dangling.slice(0, MAX_LISTED).join(', ')}${dangling.length > MAX_LISTED ? ', …' : ''}); browsers request it and get a 404.`,
      fix: 'Emit hidden source maps (sourcemap: "hidden") so no pointer is written, or keep the maps until deploy.',
      details: { pointers: dangling },
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
  if (inline.length > 0) {
    add({
      id: 'map.inline',
      severity: 'error',
      message: `${inline.length} bundle(s) carry an inline (data:) source map (${inline.slice(0, MAX_LISTED).join(', ')}); there is no .map file to upload and the map ships to every visitor.`,
      fix: 'Switch to external hidden maps (Vite `build.sourcemap: "hidden"`, webpack `devtool: "hidden-source-map"`, esbuild `sourcemap: "external"`).',
      details: { files: inline },
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
      severity: 'warning',
      message: `${maps.length} .map file(s) are on disk in ${dir}; if this directory is deployed they are served publicly and expose your source.`,
      fix: 'Keep `deleteMaps` on (default) so maps are removed after a confirmed upload, or emit hidden maps and exclude *.map from deploys.',
      details: { count: maps.length, files: maps.slice(0, MAX_LISTED).map((m) => rel(dir, m)) },
    });
  }

  // --- SRI ------------------------------------------------------------------------------------------
  const pinned = await findSriProtectedScripts(dir);
  if (pinned.length > 0) {
    const unstampedPinned: typeof pinned = [];
    for (const p of pinned) {
      let code: string;
      try {
        code = await readFile(p.script, 'utf8');
      } catch {
        continue; // a pin to a file that is not there is stale, not something stamping would break
      }
      if (readDebugId(code) === undefined) {
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
    const mismatches = await findIntegrityMismatches(dir);
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
  const outside = await integrityOutsideDir(dir);
  if (outside.length > 0) {
    add({
      id: 'sri.outside-dir',
      severity: 'warning',
      message: `${outside.map((p) => posix(relative(dir, p))).join(', ')} mention integrity hashes but are outside what the doctor can tie to a script; if they pin these bundles, stamping them afterwards breaks the page.`,
      fix: 'Check whether the page / manifest pins hashes of these files; if so make stamping happen before they are computed, or regenerate them.',
      details: { files: outside.map((p) => posix(relative(dir, p))) },
    });
  }

  // --- environment ----------------------------------------------------------------------------------
  if (options.skipEnv !== true) {
    const root = resolve(options.projectRoot ?? process.cwd());
    const fromFile = loadBuildPluginEnv(root);
    const merged = mergeBuildPluginEnv(env, fromFile.values);
    const optionToken = options.appToken?.trim() ?? '';
    const envToken = merged.BUGSEE_APP_TOKEN?.trim() ?? '';
    if (optionToken === '' && envToken === '') {
      add({
        id: 'env.token-missing',
        severity: 'error',
        message:
          'No Bugsee app token is resolvable (BUGSEE_APP_TOKEN, .env.bugsee-build-plugin, or the appToken option): the plugin is disabled and nothing is uploaded.' +
          (fromFile.problem !== undefined ? ` ${fromFile.problem}` : ''),
        fix: 'Set BUGSEE_APP_TOKEN in the build environment or in .env.bugsee-build-plugin next to your project.',
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
  return finish(dir, findings, bundles.length, maps.length, passed);
}

/** Checks that only ever produce an `info` finding: they are not "passed", they are facts. */
const INFO_ONLY: ReadonlySet<string> = new Set(['map.hidden', 'map.sources-content']);

function finish(
  dir: string,
  findings: DoctorFinding[],
  bundles: number,
  maps: number,
  passed: readonly string[],
): DoctorReport {
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
    passed: [...passed],
    findings,
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
