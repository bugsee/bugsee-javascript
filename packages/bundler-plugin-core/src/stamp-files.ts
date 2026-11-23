// The on-disk side of stamp verification and of map deletion (orchestrate.ts drives it).
//
// The in-build path verifies in memory (stamp-assets.ts). The POST-EMIT path lets `bugsee-cli` rewrite the
// output in place, so to be able to say "that stamp is not safe, put the original back" the original bytes
// have to be taken BEFORE the rewrite. That is what the snapshot is for: it covers the build's own scripts
// and maps (bounded by the same walk rules the map deletion uses), and nothing else.
//
// The originals are SPILLED to a temp directory with a content hash beside them, not held in memory: a
// build can have hundreds of megabytes of scripts and maps, and the verification only ever needs one
// bundle and its map at a time.
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { dirname, join, posix, resolve, sep } from 'node:path';
import {
  localPointerTarget,
  resolveMapName,
  type StampIssue,
  verifyStamp,
  verifyStampedPairs,
} from './verify-stamp';

/**
 * Directories never descended into when walking build output.
 *
 * A relative `output.file` resolves the output dir to `'.'` — `path.dirname('bundle.js') === '.'`, an
 * entirely ordinary Rollup library config — so a walk started at the PROJECT ROOT. With no exclusions the
 * map deletion unlinked dependency source maps under `node_modules/` and a developer's own authored maps
 * under `src/`: silent, unrecoverable loss in the working tree. The same walk now also feeds the
 * pre-stamp snapshot, and a restore writes files, so it must have the same fence.
 */
export const NEVER_WALK = new Set([
  'node_modules',
  'src',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  'test',
  'tests',
  '__tests__',
]);

/**
 * Depth limit for the walk. Build output is shallow (`dist/assets/chunk.js.map` is 2); an unbounded walk
 * from a mis-resolved root could traverse an entire disk.
 */
export const MAX_WALK_DEPTH = 6;

/**
 * Whether a path RELATIVE to an output directory runs through a directory that is not this build's output:
 * a never-walk name (`node_modules`, `src`, `test`, …) or a dot-directory. Files there are not this build's to
 * delete (the CLI's directory scan does reach them, which is why the upload is not the reference).
 */
export function isFencedPath(relative: string): boolean {
  return relative
    .split(/[\\/]/)
    .slice(0, -1)
    .some((segment) => NEVER_WALK.has(segment) || segment.startsWith('.'));
}

/** The name up to its `?query` (webpack drops it on disk). indexOf, not a regex: it runs on library input. */
export function cutAtQuery(name: string): string {
  const at = name.indexOf('?');
  return at === -1 ? name : name.slice(0, at);
}

/**
 * Whether a file under `outDir` is one THIS build emitted. By IDENTITY: the names the bundler reports for its
 * own output (relative to the output directory; separators and a leading `./` normalised, case exact), not
 * by what a directory is called. A foreign file can sit anywhere, under any name. With no names (a directory
 * run where the build's output is not known) it falls back to the directory-name fence.
 */
export function ownedBy(
  outDir: string,
  ownFiles: readonly string[] | undefined,
  /** The path implementation `outDir` and the files follow (the host's by default). */
  api: Pick<typeof path, 'relative'> = path,
): (file: string) => boolean {
  if (ownFiles === undefined) {
    return (file) => !isFencedPath(api.relative(outDir, file));
  }
  // GROUND TRUTH (real builds): webpack/Rspack drop `?...` when they write a file (`x.js.map?h` -> `x.js.map`)
  // and KEEP `#` (`a#1.js` stays); Rollup/Vite write every name literally (`index.js?v=1` stays). So each
  // own name is known both literally and without its `?query`, and a file on disk is compared literally:
  // a stale `x#old.js.map` or `index.js?old` is never mistaken for this build's.
  const normal = (name: string): string => posix.normalize(name.replace(/\\/g, '/'));
  const owned = new Set(ownFiles.flatMap((name) => [normal(name), normal(cutAtQuery(name))]));
  return (file) => owned.has(normal(api.relative(outDir, file)));
}

/** What inject can change: the scripts it stamps and the maps it pairs with them. */
const STAMPABLE = /\.([cm]?js|map)$/i;

/** Every stampable file under `dir`. An unreadable directory contributes nothing (never throws). */
async function walkStampable(dir: string, fenced: boolean, depth = 0): Promise<string[]> {
  // The depth cap bounds a walk from a PROJECT ROOT only. In an ordinary output directory the CLI's scan and
  // inject have no limit, so a cap here would leave a deep bundle stamped but never verified, uploaded or deleted.
  if (fenced && depth > MAX_WALK_DEPTH) {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Not this layer's error to raise: the CLI reports a missing output directory properly, and
    // throwing here would replace that with a worse message.
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!fenced || (!NEVER_WALK.has(entry.name) && !entry.name.startsWith('.'))) {
        found.push(...(await walkStampable(full, fenced, depth + 1)));
      }
    } else if (entry.isFile() && STAMPABLE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Where to look: a directory (walked), or exactly the files a build reported as its own. */
export type SnapshotTarget = { dir: string } | { files: readonly string[] };

/** What is kept of one original: where it was spilled, and its content hash (to tell what changed). */
export interface SnapshotEntry {
  spill: string;
  hash: string;
}

/** The originals of the build's scripts and maps, on disk in a private temp directory. */
export interface StampSnapshot {
  entries: Map<string, SnapshotEntry>;
  spillDir: string;
  /** Remove the spill directory. Always call it. */
  dispose(): Promise<void>;
}

const sha1 = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex');

/**
 * Whether `dir` IS the working directory or CONTAINS it. That is what a mis-resolved output directory
 * looks like (a bare `output.file: 'bundle.js'` resolves to `'.'`), and a snapshot-and-restore there would
 * reach across the project tree, so callers refuse to snapshot or restore it.
 *
 * Deliberately not "has a package.json": `dist/cjs` with a `{"type":"commonjs"}` marker, or a `dist/` with
 * a copied manifest (ng-packagr), are ordinary output directories and must be verified like any other.
 */
export async function isProjectRootOrAbove(dir: string): Promise<boolean> {
  // Real paths: the cwd is reported resolved (macOS /private/var), an output directory may be spelled
  // through a symlink.
  const full = await realpath(dir).catch(() => resolve(dir));
  let cwd: string;
  try {
    cwd = await realpath(process.cwd());
  } catch {
    // The working directory is gone: nothing can be the project root.
    return false;
  }
  return cwd === full || cwd.startsWith(full.endsWith(sep) ? full : full + sep);
}

/**
 * Spill the originals of every stampable file in `target`. A file that is gone is skipped. If spilling
 * fails (a full disk), the spill directory is removed and the error propagates: the caller has not
 * injected yet, and an unverifiable, unrestorable stamp is exactly what this layer exists to prevent.
 *
 * The walk is fenced (`src`, `test`, `node_modules`, dot-directories skipped) ONLY when the directory is
 * the project root or above: there it keeps the walk out of the source tree. In an ordinary output
 * directory inject stamps everything (Rollup `preserveModules` writes `dist/src/*.js`), so the snapshot
 * must see everything inject can change.
 */
export async function snapshotStampFiles(
  target: SnapshotTarget,
  /** Where the spill directory is created (default: the OS temp directory). */
  spillRoot: string = tmpdir(),
): Promise<StampSnapshot> {
  const paths =
    'dir' in target
      ? await walkStampable(target.dir, await isProjectRootOrAbove(target.dir))
      : target.files;
  const spillDir = await mkdtemp(join(spillRoot, 'bugsee-orig-'));
  const entries = new Map<string, SnapshotEntry>();
  try {
    let index = 0;
    for (const original of paths) {
      let bytes: Buffer;
      try {
        bytes = await readFile(original);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Gone between listing and reading (a concurrent build's cleanup): nothing to verify or restore.
          continue;
        }
        // Anything else (EACCES, EISDIR, a transient I/O error) is NOT "gone": injecting with an incomplete
        // snapshot would leave a file nothing can verify or restore. Abort (the spill is removed below).
        throw error;
      }
      const spill = join(spillDir, String(index++));
      await writeFile(spill, bytes);
      entries.set(original, { spill, hash: sha1(bytes) });
    }
  } catch (error) {
    await rm(spillDir, { recursive: true, force: true });
    throw error;
  }
  return {
    entries,
    spillDir,
    dispose: () => rm(spillDir, { recursive: true, force: true }),
  };
}

/** Whether `file` still has the bytes it had when the snapshot was taken (false when it changed or is gone). */
export async function sameAsSnapshot(snapshot: StampSnapshot, file: string): Promise<boolean> {
  const entry = snapshot.entries.get(file);
  if (entry === undefined) {
    return true;
  }
  try {
    return sha1(await readFile(file)) === entry.hash;
  } catch {
    return false;
  }
}

/** Put the ORIGINAL bytes of these files back (atomically); returns the ones that could not be restored. */
export async function restorePaths(
  snapshot: StampSnapshot,
  files: readonly string[],
): Promise<Array<{ path: string; error: string }>> {
  const failed: Array<{ path: string; error: string }> = [];
  for (const file of files) {
    const entry = snapshot.entries.get(file);
    if (entry === undefined) {
      continue;
    }
    try {
      await restoreAtomically(entry.spill, file);
    } catch (error) {
      failed.push({ path: file, error: String(error) });
    }
  }
  return failed;
}

export interface RestoreOptions {
  /** Injectable JavaScript parser for the verification (default: acorn). */
  parse?: (code: string) => boolean;
  /** Injectable restore of one file from its spilled original (default: write temp, then rename). */
  restoreFile?: (spill: string, target: string) => Promise<void>;
}

/**
 * Atomic restore: the target is either the stamped file or the original, never half of either, and it
 * keeps its identity — the file mode (a 0755 shebang bundle stays executable) and, when the path is a
 * symlink, the link itself (the real file behind it is replaced).
 */
export async function restoreAtomically(spill: string, target: string): Promise<void> {
  const real = await realpath(target).catch(() => target);
  const mode = await stat(real).then(
    (info) => info.mode & 0o7777,
    () => undefined,
  );
  const temp = join(dirname(real), `.bugsee-restore-${process.pid}-${Date.now()}`);
  try {
    await writeFile(temp, await readFile(spill));
    if (mode !== undefined) {
      await chmod(temp, mode);
    }
    await rename(temp, real);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Verify what inject left on disk against the snapshot, and put the ORIGINAL bytes back for every file that
 * failed — together with its partner (a bundle and its map are restored as a pair, so a build is never
 * left half-stamped: a bundle with an id and a map without one is worse than neither). The bundle goes back
 * first. A restore that fails is not swallowed: it is returned by name in `failed`, and the others still run.
 *
 * Only one bundle and its map are held in memory at a time. The pair is resolved from the bundle's own
 * `sourceMappingURL`, so a map with a custom name is held to its bundle too.
 */
export async function verifyAndRestore(
  snapshot: StampSnapshot,
  options: RestoreOptions = {},
): Promise<{
  issues: StampIssue[];
  restored: string[];
  failed: Array<{ path: string; error: string }>;
}> {
  const { entries } = snapshot;
  const read = async (file: string): Promise<Buffer | undefined> => {
    try {
      return await readFile(file);
    } catch {
      return undefined; // deleted meanwhile: not part of the comparison
    }
  };
  const original = (file: string): Promise<Buffer> =>
    readFile((entries.get(file) as SnapshotEntry).spill);

  // What changed, by hash — one file in memory at a time.
  const changed: string[] = [];
  for (const [file, entry] of entries) {
    const now = await read(file);
    if (now !== undefined && sha1(now) !== entry.hash) {
      changed.push(file);
    }
  }

  const issues: StampIssue[] = [];
  const partner = new Map<string, string>();
  const paired = new Set<string>();
  const stampedBundles = changed.filter((file) => /\.[cm]?js$/i.test(file));
  for (const bundle of stampedBundles) {
    const after = await read(bundle);
    if (after === undefined) {
      continue; // removed since the change scan: nothing to compare, and a restore would not recreate it
    }
    const map = resolveMapName(bundle, after.toString('utf8'), (n) => entries.has(n), path);
    paired.add(map);
    const originalBundle = await original(bundle);
    // The ROLLBACK partner is the map the ORIGINAL bundle pointed at (a bad stamp may have changed the pointer);
    // verification still looks at the current one.
    const originalMap = resolveMapName(
      bundle,
      originalBundle.toString('utf8'),
      (n) => entries.has(n),
      path,
    );
    if (entries.has(originalMap)) {
      partner.set(bundle, originalMap);
      partner.set(originalMap, bundle);
    }
    const before = new Map([[bundle, originalBundle]]);
    const now = new Map([[bundle, after]]);
    if (entries.has(map)) {
      partner.set(bundle, partner.get(bundle) ?? map);
      partner.set(map, bundle);
      before.set(map, await original(map));
      const mapNow = await read(map);
      if (mapNow !== undefined) {
        now.set(map, mapNow);
      }
    }
    issues.push(...verifyStamp(before, now, options.parse, path));
    // A pointer that reaches a map OUTSIDE the snapshotted output: inject cannot have stamped it.
    const target = localPointerTarget(bundle, after.toString('utf8'), path);
    if (
      target !== undefined &&
      !entries.has(target) &&
      (await stat(target).then(
        () => true,
        () => false,
      ))
    ) {
      issues.push({
        name: bundle,
        reason: `its source map (${target}) lies outside the output directory, so it cannot be stamped with the bundle`,
      });
    }
  }
  for (const file of changed) {
    if (file.endsWith('.map') && !paired.has(file)) {
      issues.push(
        ...verifyStamp(
          new Map([[file, await original(file)]]),
          new Map([[file, (await read(file)) as Buffer]]),
          options.parse,
          path,
        ),
      );
    }
  }

  const toRestore = new Set<string>();
  for (const { name } of issues) {
    toRestore.add(name);
    const other = partner.get(name);
    if (other !== undefined) {
      toRestore.add(other);
    }
  }
  const restoreFile = options.restoreFile ?? restoreAtomically;
  const restored: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  // Bundles before maps: if the run dies halfway, a bundle with no id beside a map with one is the
  // lesser harm (the upload then fails loudly) than a stamped bundle beside an unstamped map.
  const order = [...toRestore].sort(
    (a, b) => Number(a.endsWith('.map')) - Number(b.endsWith('.map')) || a.localeCompare(b),
  );
  const failedPaths = new Set<string>();
  for (const file of order) {
    // A map is not restored when its bundle could not be: the stamped bundle would then point at an
    // original map that does not carry its new id. Reported as incomplete; unrelated pairs still restore.
    const pairedBundle = file.endsWith('.map') ? partner.get(file) : undefined;
    if (pairedBundle !== undefined && failedPaths.has(pairedBundle)) {
      failedPaths.add(file);
      failed.push({
        path: file,
        error: `not restored: its bundle ${pairedBundle} could not be restored`,
      });
      continue;
    }
    try {
      await restoreFile((entries.get(file) as SnapshotEntry).spill, file);
      restored.push(file);
    } catch (error) {
      failedPaths.add(file);
      failed.push({ path: file, error: String(error) });
    }
  }
  return { issues, restored, failed };
}

/**
 * Check the named bundles AS THEY ARE ON DISK after the bundler wrote them (the in-build path): each bundle
 * with a map must carry a debugId its map shares (verifyStampedPairs). Only these bundles are judged — never
 * the directory — so a file that was not part of the bundle (a `public/` script, a stale file with
 * `emptyOutDir: false`) is not mistaken for one the stamp missed. One bundle and its map in memory at a time.
 */
export async function verifyStampedOnDisk(
  bundles: readonly string[],
  /** The build's own bundle -> map mapping (absolute paths), tried before the pointer and the sibling. */
  known: ReadonlyMap<string, string> = new Map(),
): Promise<StampIssue[]> {
  const issues: StampIssue[] = [];
  for (const bundle of bundles) {
    let code: Buffer;
    try {
      code = await readFile(bundle);
    } catch (error) {
      // The stamp named this bundle, so it must be there: say so rather than skip it (a stale or public
      // script is never in `bundles`, so this does not judge them).
      issues.push({
        name: bundle,
        reason: `the stamped bundle could not be read: ${String(error)}`,
      });
      continue;
    }
    const files = new Map([[bundle, code]]);
    const pointed = resolveMapName(bundle, code.toString('utf8'), () => true, path);
    const hinted = known.get(bundle);
    // The pair that was ACTUALLY loaded is the one verified (a missing known map must not make a loaded
    // sibling go unchecked).
    let hint: ReadonlyMap<string, string> = new Map();
    // Candidates in order: the build's own map, the bundle's pointer, the `<bundle>.map` sibling inject pairs by
    // default. The first that loads is the one verified.
    const candidates = [...new Set([hinted, pointed, `${bundle}.map`])].filter(
      (name): name is string => name !== undefined,
    );
    let loaded = false;
    for (const candidate of candidates) {
      try {
        files.set(candidate, await readFile(candidate));
        loaded = true;
        if (candidate === hinted) {
          hint = known; // only once the known map was really loaded
        }
        break;
      } catch {
        // try the next candidate
      }
    }
    if (!loaded && hinted !== undefined) {
      issues.push({ name: hinted, reason: 'the stamped map could not be read' });
      continue;
    }
    issues.push(...verifyStampedPairs(files, hint));
  }
  return issues;
}

/** Maps `debug-files upload` never takes: stylesheet and declaration maps have no debug-id. */
const NOT_UPLOADED_MAP = /\.(css|d\.ts|d\.mts|d\.cts)\.map$/;

/**
 * Whether `path` is a map the CLI scans a directory for: every `*.map` except stylesheet and declaration
 * maps. NOT only `*.js.map`: the stamp keys a map whatever it is called (`sourcemapFileName(s)`, webpack's
 * `[name].map`), so a narrower filter would silently drop a stamped build's maps.
 */
export function isUploadableMap(path: string): boolean {
  return path.endsWith('.map') && !NOT_UPLOADED_MAP.test(path);
}

/**
 * Every map under `dir` (`*.map`, whatever its name), walked like the snapshot: the whole output directory,
 * fenced only at a project root. The SINGLE walk behind what a pre-stamped build uploads and deletes; the
 * caller splits it with {@link isUploadableMap}.
 */
export async function listOutputMaps(dir: string): Promise<string[]> {
  const all = await walkStampable(dir, await isProjectRootOrAbove(dir));
  return all.filter((file) => file.endsWith('.map'));
}

/**
 * Split `maps` into those that may be deleted after an upload and those that must be kept.
 *
 * `debug-files upload` skips a map with no debug-id and still exits 0 (it counts it as `unkeyed`), so "the
 * upload command succeeded" does NOT mean "this map was uploaded". Deleting on that evidence destroys the
 * only copy of a mapping whose symbols never left the build machine. A script map is therefore deletable
 * only if it carries a `debugId`/`debug_id` — what makes it keyed. Anything else (a stylesheet map, which
 * is never uploaded and embeds the source, so privacy still wants it gone) is deletable as before. A map
 * that cannot be read or parsed is kept: not confirmed means not deleted.
 */
export async function partitionByKeyed(
  maps: readonly string[],
): Promise<{ deletable: string[]; kept: string[] }> {
  const deletable: string[] = [];
  const kept: string[] = [];
  for (const path of maps) {
    if (!isUploadableMap(path)) {
      deletable.push(path);
      continue;
    }
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Already gone: nothing to delete and nothing to keep.
        continue;
      }
      // Anything else (EACCES, a map too large to read as a string) is NOT "gone": it cannot be confirmed
      // keyed, so it is neither uploaded nor deleted, and the caller says so.
      kept.push(path);
      continue;
    }
    let keyed = false;
    try {
      const parsed = JSON.parse(text) as { debugId?: unknown; debug_id?: unknown } | null;
      keyed = [parsed?.debugId, parsed?.debug_id].some((id) => typeof id === 'string' && id !== '');
    } catch {
      // Not JSON: cannot have been keyed.
    }
    (keyed ? deletable : kept).push(path);
  }
  return { deletable, kept };
}
