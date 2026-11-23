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
  read(name: string): Buffer;
  update(name: string, content: Buffer): void;
  /**
   * Called for EVERY asset about to be written back, before ANY is: throw to refuse the whole stamp (a store
   * that can only hold text refuses bytes that are not valid text), so a refusal never leaves a half-written build.
   */
  check?(name: string, content: Buffer): void;
  /**
   * The asset that is the source map of the bundle `name`, when the bundler can say (a Rollup chunk's
   * `sourcemapFileName`). inject pairs a bundle with its map by the sibling name `<bundle>.map`, so a map
   * the bundler MOVED is staged under that name; without this a moved map is simply not found and the
   * bundle would be stamped with an id that was never put in the map.
   */
  mapOf?(name: string): string | undefined;
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
  /** A map lies outside the output: stamping after emit cannot reach it either, so a retry would half-stamp. */
  get unreachableMap(): boolean {
    return this.issues.some((issue) => issue.outside === true);
  }
  constructor(issues: StampIssue[]) {
    super(`the debug-ID stamp did not verify, so none of it was applied (${formatIssues(issues)})`);
    this.name = 'StampVerificationError';
    this.issues = issues;
  }
}

export interface StampAssetsResult {
  /** The bundles inject rewrote (their maps are rewritten alongside, and not listed), sorted. */
  stamped: string[];
  /** How many bundles were staged for inject (0: nothing the stamp could match, whatever the store holds). */
  bundles: number;
  /** Each stamped bundle's source map, by real asset name, where it has one: what the on-disk re-check uses. */
  maps: Record<string, string>;
}

/** What inject stamps (`.js`/`.cjs`/`.mjs`), and the maps it pairs them with. */
const BUNDLE = /\.[cm]?js$/i;
const STAGED = /\.([cm]?js|map)$/i;

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
    return { stamped: [], maps: {}, bundles: 0 };
  }
  // A map that is not the bundle's sibling is staged AS the sibling (and written back at its real name).
  const stageName = new Map<string, string>();
  const stagedSet = new Set(staged);
  // Every map a bundle names (its own sibling included) belongs to ONE bundle: two claimants would be
  // verified against the same file and one of them accepted with no map of its own.
  const claimed = new Map<string, string>();
  for (const bundle of staged.filter((name) => BUNDLE.test(name))) {
    const map = store.mapOf?.(bundle);
    const sibling = `${bundle}.map`;
    if (map !== undefined) {
      const other = claimed.get(map);
      if (other !== undefined) {
        throw new Error(
          `the map ${map} is claimed by more than one bundle (${other} and ${bundle}), so it cannot be stamped`,
        );
      }
      claimed.set(map, bundle);
    }
    if (map === undefined || map === sibling) {
      continue;
    }
    if (!stagedSet.has(map)) {
      // Not something that can be staged (not a .map name): stamping the bundle alone would be a silent
      // half-stamp, so the whole stamp is refused and the caller falls back.
      throw new StampVerificationError([
        {
          name: map,
          reason: staysInside(map)
            ? `the map of ${bundle} cannot be staged for stamping (not a .map file)`
            : `the map of ${bundle} lies outside the output directory, so it cannot be stamped with the bundle. Emit the maps inside the output directory, or upload them yourself with bugsee-cli (sourcemaps inject, then debug-files upload).`,
          ...(staysInside(map) ? {} : { outside: true as const }),
        },
      ]);
    }
    if (stagedSet.has(sibling)) {
      throw new Error(
        `the map ${map} of ${bundle} cannot be staged as ${sibling}: another asset already has that name`,
      );
    }
    stageName.set(map, sibling);
  }
  const stagedAs = (name: string): string => stageName.get(name) ?? name;
  // Staging writes each asset to a file named after it. Two names that differ only by case are two
  // assets in the bundler but ONE file on a case-insensitive disk (macOS, Windows), where the second would
  // overwrite the first and verification would compare the wrong bytes. Refuse rather than guess: the
  // caller's fallback stamps the real output directory, where such a collision cannot exist.
  const seen = new Map<string, string>();
  for (const name of staged.map(stagedAs)) {
    const clash = seen.get(name.toLowerCase());
    if (clash !== undefined && clash !== name) {
      throw new Error(
        `assets ${clash} and ${name} differ only by case, so they cannot be staged side by side on a case-insensitive file system`,
      );
    }
    seen.set(name.toLowerCase(), name);
  }
  const dryRun = options.dryRun ?? false;
  const root = await mkdtemp(join(tmpdir(), 'bugsee-stamp-'));
  try {
    const before = new Map<string, Buffer>();
    for (const name of staged) {
      const bytes = store.read(name);
      before.set(stagedAs(name), bytes);
      const path = join(root, stagedAs(name));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }

    // No token: inject is a local rewrite and needs no credentials.
    await (options.run ?? runBugseeCli)(
      ['sourcemaps', 'inject', root, ...(dryRun ? ['--dry-run'] : [])],
      {},
    );

    const bundles = staged.filter((name) => BUNDLE.test(name)).length;
    if (dryRun) {
      return { stamped: [], maps: {}, bundles };
    }
    // Read everything back and verify BEFORE writing anything: a bad stamp must leave the build exactly
    // as the bundler produced it, which an interleaved read-and-update could not promise.
    const after = new Map<string, Buffer>();
    for (const name of staged) {
      after.set(stagedAs(name), await readFile(join(root, stagedAs(name))));
    }
    const issues = verifyStamp(before, after, options.parse);
    if (issues.length > 0) {
      throw new StampVerificationError(issues);
    }
    for (const name of staged) {
      const afterBytes = after.get(stagedAs(name)) as Buffer;
      if (!afterBytes.equals(before.get(stagedAs(name)) as Buffer)) {
        store.check?.(name, afterBytes);
      }
    }
    const stamped: string[] = [];
    for (const name of staged) {
      const afterBytes = after.get(stagedAs(name)) as Buffer;
      // Only what inject actually changed goes back. An untouched asset keeps its original Source
      // object, so webpack's caching and any map information it carries are not disturbed.
      if (!afterBytes.equals(before.get(stagedAs(name)) as Buffer)) {
        store.update(name, afterBytes);
        if (BUNDLE.test(name)) {
          stamped.push(name);
        }
      }
    }
    const maps: Record<string, string> = {};
    for (const bundle of stamped) {
      const map = store.mapOf?.(bundle) ?? `${bundle}.map`;
      if (stagedSet.has(map)) {
        maps[bundle] = map;
      }
    }
    return { stamped: stamped.sort(), maps, bundles };
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
    mapOf: (name) => {
      const entry = bundle[name];
      if (entry?.type !== 'chunk') {
        return undefined;
      }
      const map = entry.sourcemapFileName ?? `${name}.map`;
      return bundle[map] === undefined ? undefined : map;
    },
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
