// Which files of a Next build the upload covers, named explicitly. The upload never walks `.next` and never
// takes a directory: it is handed exactly these paths, so it cannot stamp, upload or delete a file that is not
// part of the build it is looking at (the webpack compilations and the Turbopack output share `.next`).
import { open, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** A build's bundles and the maps that belong to them. */
export interface BuildFiles {
  /** Bundles that have a map. A bundle without one cannot be symbolicated, so it is never stamped. */
  scripts: string[];
  /** The maps of those bundles. */
  maps: string[];
  /** Stylesheet maps: never sent, but deleted with the rest after a confirmed upload (they embed the source). */
  stylesheetMaps: string[];
  /** Bundles left out because their map is shared with another bundle (see {@link pairByPointer}). */
  shared?: string[];
}

const SCRIPT = /\.[cm]?js$/i;
/** How much of the END of a file is read to find its source-map comment (the comment is a line or two). */
const TAIL_BYTES = 16 * 1024;
/** Directories that are never build output, wherever they appear (a route may well be called `cache`). */
const SKIP = new Set(['node_modules']);

/** The last {@link TAIL_BYTES} of a file as text (the whole file when it is smaller). */
async function readTail(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function listFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A directory the build did not produce (no `server` output, say) contributes nothing; any other failure
    // (EACCES, EIO) is NOT "nothing to upload" and is left to the caller's failure policy.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) {
        found.push(...(await listFiles(full)));
      }
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

/** Split a list of files into the bundles that have a map, their maps, and the stylesheet maps. */
export function partitionBuildFiles(files: readonly string[]): BuildFiles {
  const present = new Set(files);
  const scripts = files.filter((file) => SCRIPT.test(file) && present.has(`${file}.map`));
  const owned = new Set(scripts);
  return {
    scripts: scripts.sort(),
    maps: files.filter((file) => file.endsWith('.map') && owned.has(file.slice(0, -4))).sort(),
    stylesheetMaps: files.filter((file) => file.endsWith('.css.map')).sort(),
  };
}

/** A bundle's source-map pointer: the last `//# sourceMappingURL=` comment (a `/*# ... *\/` comment in a stylesheet). */
const POINTER = /\/\/[#@] sourceMappingURL=([^\s'"]+)\s*$/;
const CSS_POINTER = /\/\*[#@] sourceMappingURL=([^\s'"*]+)\s*\*\/\s*$/;

/** The path a bundle's source-map comment names, or `undefined` when it has none or the map is inline. */
export function mapPointerOf(file: string, code: string): string | undefined {
  const reference = (file.endsWith('.css') ? CSS_POINTER : POINTER).exec(code)?.[1];
  if (reference === undefined || reference.startsWith('data:')) {
    return undefined;
  }
  let decoded = reference;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    // Not percent-encoded after all: use it as written.
  }
  return resolve(dirname(file), decoded);
}

/**
 * Pair bundles with their maps by the pointer inside each bundle, not by name. Turbopack does not name a map after
 * its bundle (measured, Next 16.4: `chunks/0ihtwxitjxx9w.js` ends in `sourceMappingURL=1wkfrb_3m2k-z.js.map`), so
 * `<bundle>.map` finds nothing there. Only a pointer that names a `.map` file that exists counts.
 */
export async function pairByPointer(
  files: readonly string[],
  read: (file: string) => Promise<string> = readTail,
): Promise<BuildFiles> {
  const present = new Set(files);
  const pointers = new Map<string, string>();
  const users = new Map<string, number>();
  for (const file of files.filter((f) => SCRIPT.test(f))) {
    const map = mapPointerOf(file, await read(file));
    if (map?.endsWith('.map') && present.has(map)) {
      pointers.set(file, map);
      users.set(map, (users.get(map) ?? 0) + 1);
    }
  }
  // Stylesheet maps are never uploaded but embed the source, so they are deleted with the rest, and only THIS
  // build's: a stylesheet map is this build's when one of its stylesheets points at it. A `.css.map` (or a
  // `.d.ts.map`) that nothing here points at was put there by something else, and is left alone.
  const styles = new Set<string>();
  for (const file of files.filter((f) => f.endsWith('.css'))) {
    const map = mapPointerOf(file, await read(file));
    if (map?.endsWith('.map') && present.has(map)) {
      styles.add(map);
    }
  }
  // A map belongs to one bundle: a debug-ID is the hash of the bundle AND its map, and a map carries one. Two
  // bundles pointing at the same map (Next 15.5's Turbopack does this for its runtime chunks, measured) cannot both
  // be keyed to it, so neither is paired: stamping one would leave the other with an id no map answers to.
  const paired = [...pointers].filter(([, map]) => users.get(map) === 1);
  return {
    scripts: paired.map(([file]) => file).sort(),
    maps: paired.map(([, map]) => map).sort(),
    stylesheetMaps: [...styles].sort(),
    shared: [...pointers]
      .filter(([, map]) => (users.get(map) as number) > 1)
      .map(([file]) => file)
      .sort(),
  };
}

/** The build files under `dir` (recursively), paired by pointer; none when `dir` does not exist. */
export async function collectBuildFiles(dir: string): Promise<BuildFiles> {
  return pairByPointer(await listFiles(dir));
}
