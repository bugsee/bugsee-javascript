// The on-disk side of stamp verification and of map deletion (orchestrate.ts drives it).
//
// The in-build path verifies in memory (stamp-assets.ts). The POST-EMIT path lets `bugsee-cli` rewrite the
// output in place, so to be able to say "that stamp is not safe, put the original back" the original bytes
// have to be taken BEFORE the rewrite. That is what the snapshot is for: it holds the build's own scripts
// and maps (bounded by the same walk rules the map deletion uses), and nothing else.
import type { Dirent } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type StampIssue, verifyStamp } from './verify-stamp';

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

/** What inject can change: the scripts it stamps and the maps it pairs with them. */
const STAMPABLE = /\.([cm]?js|map)$/;

/** Every stampable file under `dir`. An unreadable directory contributes nothing (never throws). */
async function walkStampable(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_WALK_DEPTH) {
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
      if (!NEVER_WALK.has(entry.name) && !entry.name.startsWith('.')) {
        found.push(...(await walkStampable(full, depth + 1)));
      }
    } else if (entry.isFile() && STAMPABLE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Where to look: a directory (walked), or exactly the files a build reported as its own. */
export type SnapshotTarget = { dir: string } | { files: readonly string[] };

/** The bytes of every stampable file in `target`, keyed by absolute path. A file that is gone is skipped. */
export async function snapshotStampFiles(target: SnapshotTarget): Promise<Map<string, Buffer>> {
  const paths = 'dir' in target ? await walkStampable(target.dir) : target.files;
  const snapshot = new Map<string, Buffer>();
  for (const path of paths) {
    try {
      snapshot.set(path, await readFile(path));
    } catch {
      // Gone between listing and reading (a concurrent build's cleanup): nothing to verify or restore.
    }
  }
  return snapshot;
}

/** The map of a bundle, or the bundle of a map. */
const partner = (path: string): string =>
  path.endsWith('.map') ? path.slice(0, -'.map'.length) : `${path}.map`;

/**
 * Verify what inject left on disk against the `before` snapshot, and put the ORIGINAL bytes back for every
 * file that failed — together with its partner (a bundle and its map are restored as a pair, so a build is
 * never left half-stamped: a bundle with an id and a map without one is worse than neither).
 *
 * Returns the issues (empty when the stamp is sound) and the paths restored.
 */
export async function verifyAndRestore(
  before: ReadonlyMap<string, Buffer>,
  parser?: (code: string) => boolean,
): Promise<{ issues: StampIssue[]; restored: string[] }> {
  const after = new Map<string, Buffer>();
  for (const path of before.keys()) {
    try {
      after.set(path, await readFile(path));
    } catch {
      // Deleted meanwhile: not part of the comparison.
    }
  }
  const issues = verifyStamp(before, after, parser);
  const toRestore = new Set<string>();
  for (const { name } of issues) {
    toRestore.add(name);
    if (before.has(partner(name))) {
      toRestore.add(partner(name));
    }
  }
  const restored: string[] = [];
  for (const path of [...toRestore].sort()) {
    await writeFile(path, before.get(path) as Buffer);
    restored.push(path);
  }
  return { issues, restored };
}

/** Script maps are the ones inject keys and the CLI uploads; a stylesheet map is neither. */
const SCRIPT_MAP = /\.[cm]?js\.map$/;

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
    if (!SCRIPT_MAP.test(path)) {
      deletable.push(path);
      continue;
    }
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      // Already gone: nothing to delete and nothing to keep.
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
