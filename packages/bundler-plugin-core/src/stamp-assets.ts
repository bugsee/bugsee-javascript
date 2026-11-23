// Stamp debug-ids INTO the build, before it is written — the real fix for Subresource Integrity.
//
// The post-emit path runs `bugsee-cli sourcemaps inject` over the output directory, which appends bytes
// to every bundle AFTER a plugin such as `webpack-subresource-integrity` has hashed it. The hash in the
// HTML — and, for lazy chunks, the `sriHashes` table that plugin embeds in the runtime chunk — then
// describes bytes that no longer exist, and the browser refuses to run the page. The guard in sri.ts
// refuses to stamp such a build, which trades a broken page for unsymbolicated crashes.
//
// Stamping inside the compilation, at a stage BEFORE the hashes are taken, removes the conflict: the
// SRI plugin hashes the stamped bytes, for the HTML and the lazy-chunk table alike.
//
// The Rust `inject` stays the one implementation. This stages the bundles and maps in a temp directory
// with the same relative layout, runs the real `sourcemaps inject` over it, and reads back what it
// changed. A JavaScript reimplementation of the debug-id algorithm and the runtime stub is exactly the
// second copy that drifts ("spawn the existing Rust bugsee-cli").
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { RunFn } from './orchestrate';
import { runBugseeCli } from './run-cli';
import { formatIssues, type StampIssue, verifyStamp } from './verify-stamp';

/** The slice of a compilation's asset table this needs — no bundler types in the core. */
export interface AssetStore {
  names(): string[];
  read(name: string): Buffer | string;
  update(name: string, content: Buffer): void;
}

export interface StampAssetsOptions {
  /** Preview only: run `inject --dry-run` and write nothing back. */
  dryRun?: boolean;
  run?: RunFn;
  /** Injectable JavaScript parser for the post-stamp check (default: acorn, see verify-stamp.ts). */
  parse?: (code: string) => boolean;
}

/**
 * The stamp did not verify (verify-stamp.ts): something inject produced is not safe to ship. Nothing was
 * written back. Carries every issue, so a caller can say exactly which asset and why.
 */
export class StampVerificationError extends Error {
  readonly issues: StampIssue[];
  constructor(issues: StampIssue[]) {
    super(`the debug-ID stamp did not verify, so none of it was applied (${formatIssues(issues)})`);
    this.name = 'StampVerificationError';
    this.issues = issues;
  }
}

export interface StampAssetsResult {
  /** The bundles inject rewrote (their maps are rewritten alongside, and not listed). */
  stamped: string[];
}

/** What inject stamps (`.js`/`.cjs`/`.mjs`), and the maps it pairs them with. */
const BUNDLE = /\.[cm]?js$/;
const STAGED = /\.([cm]?js|map)$/;

/** A relative asset name that stays inside the staging directory once joined to it. */
function staysInside(name: string): boolean {
  if (isAbsolute(name)) {
    return false;
  }
  const normal = normalize(name);
  return normal !== '..' && !normal.startsWith(`..${sep}`);
}

/**
 * Run the real `bugsee-cli sourcemaps inject` over the store's bundles and maps, and write back
 * every asset it changed. Throws on an inject failure — the caller decides what that means.
 */
export async function stampAssets(
  store: AssetStore,
  options: StampAssetsOptions = {},
): Promise<StampAssetsResult> {
  const staged = store.names().filter((name) => STAGED.test(name) && staysInside(name));
  if (!staged.some((name) => BUNDLE.test(name))) {
    return { stamped: [] };
  }
  const dryRun = options.dryRun ?? false;
  const root = await mkdtemp(join(tmpdir(), 'bugsee-stamp-'));
  try {
    const before = new Map<string, Buffer>();
    for (const name of staged) {
      const content = store.read(name);
      const bytes = typeof content === 'string' ? Buffer.from(content) : content;
      before.set(name, bytes);
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }

    // No token: inject is a local rewrite and needs no credentials.
    await (options.run ?? runBugseeCli)(
      ['sourcemaps', 'inject', root, ...(dryRun ? ['--dry-run'] : [])],
      {},
    );

    if (dryRun) {
      return { stamped: [] };
    }
    // Read everything back and verify BEFORE writing anything: a bad stamp must leave the build exactly
    // as the bundler produced it, which an interleaved read-and-update could not promise.
    const after = new Map<string, Buffer>();
    for (const name of staged) {
      after.set(name, await readFile(join(root, name)));
    }
    const issues = verifyStamp(before, after, options.parse);
    if (issues.length > 0) {
      throw new StampVerificationError(issues);
    }
    const stamped: string[] = [];
    for (const name of staged) {
      const afterBytes = after.get(name) as Buffer;
      // Only what inject actually changed goes back. An untouched asset keeps its original Source
      // object, so webpack's caching and any map information it carries are not disturbed.
      if (!afterBytes.equals(before.get(name) as Buffer)) {
        store.update(name, afterBytes);
        if (BUNDLE.test(name)) {
          stamped.push(name);
        }
      }
    }
    return { stamped: stamped.sort() };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A Rollup / Vite / Rolldown output chunk, as far as stamping reads or writes it. */
interface RollupChunkLike {
  type: 'chunk';
  fileName: string;
  code: string;
  map?: unknown;
  sourcemapFileName?: string | null;
}

/** An emitted asset (a `.map` file, a copied script, an image, the HTML). */
interface RollupAssetLike {
  type: 'asset';
  fileName: string;
  source: string | Uint8Array;
}

/** The `bundle` object `generateBundle` receives, keyed by output file name. */
export type RollupBundleLike = Record<string, RollupChunkLike | RollupAssetLike>;

/**
 * A Rollup / Vite output bundle as an {@link AssetStore}, so `generateBundle` can stamp what is about to
 * be written. Chunks are read and written through `.code`; the `.map` files are bundle ASSETS (measured:
 * Rollup 4.65, Vite 7.3 and Vite 8.3/Rolldown all list `<chunk>.map` in the bundle, and their
 * `source` is what reaches disk — `chunk.map` is NOT written back, so editing it would silently do
 * nothing). An asset keeps the type it had (string or bytes).
 */
export function rollupAssetStore(bundle: RollupBundleLike): AssetStore {
  return {
    names: () => Object.keys(bundle).filter((name) => STAGED.test(name)),
    read: (name) => {
      const entry = bundle[name];
      if (entry === undefined) {
        return Buffer.alloc(0);
      }
      const content = entry.type === 'chunk' ? entry.code : entry.source;
      return typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    },
    update: (name, content) => {
      const entry = bundle[name] as RollupChunkLike | RollupAssetLike;
      if (entry.type === 'chunk') {
        entry.code = content.toString('utf8');
      } else {
        entry.source =
          typeof entry.source === 'string' ? content.toString('utf8') : new Uint8Array(content);
        carryDebugId(bundle, name, content);
      }
    },
  };
}

/**
 * Put a stamped map's debug-id on the `chunk.map` object that belongs to it. Vite rewrites a chunk with
 * dynamic imports after the `generateBundle` hooks (its preload-marker substitution) and REGENERATES the
 * `.map` asset from `chunk.map`, keeping only what that object carries — its `debugId` — so an id that
 * lives only in the asset would be silently dropped (measured, Vite 7.3 and 8.3).
 */
function carryDebugId(bundle: RollupBundleLike, mapName: string, content: Buffer): void {
  let parsed: { debugId?: unknown; debug_id?: unknown };
  try {
    parsed = JSON.parse(content.toString('utf8')) as typeof parsed;
  } catch {
    return;
  }
  const id = [parsed?.debugId, parsed?.debug_id].find((v) => typeof v === 'string' && v !== '');
  if (id === undefined) {
    return;
  }
  for (const [name, entry] of Object.entries(bundle)) {
    if (
      entry.type === 'chunk' &&
      (entry.sourcemapFileName ?? `${name}.map`) === mapName &&
      typeof entry.map === 'object' &&
      entry.map !== null
    ) {
      Object.assign(entry.map, { debugId: id, debug_id: id });
    }
  }
}

/**
 * The script chunks that HAVE a source map (`chunk.map`) but whose map is not a bundle asset, so stamping
 * the code in memory could not stamp the map that reaches disk. An older Rollup that writes the `.map` file
 * from `chunk.map` at write time, or `sourcemap: 'inline'`. Such a build cannot be stamped in the
 * build; it falls back to stamping after emit, exactly as before.
 */
export function rollupUnstampableMaps(bundle: RollupBundleLike): string[] {
  const names: string[] = [];
  for (const [name, entry] of Object.entries(bundle)) {
    if (entry.type !== 'chunk' || !BUNDLE.test(name) || !entry.map) {
      continue;
    }
    const mapName = entry.sourcemapFileName ?? `${name}.map`;
    if (bundle[mapName] === undefined) {
      names.push(name);
    }
  }
  return names.sort();
}
