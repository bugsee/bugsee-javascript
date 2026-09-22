// Stamp debug-ids INTO the build, before it is written — the real fix for Subresource Integrity
// (docs/review/cli-js-flows.md §7, option 1).
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
// second copy that drifts (docs/design/source-maps.md: "spawn the existing Rust bugsee-cli").
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { RunFn } from './orchestrate';
import { runBugseeCli } from './run-cli';

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
    const stamped: string[] = [];
    for (const name of staged) {
      const after = await readFile(join(root, name));
      // Only what inject actually changed goes back. An untouched asset keeps its original Source
      // object, so webpack's caching and any map information it carries are not disturbed.
      if (!after.equals(before.get(name) as Buffer)) {
        store.update(name, after);
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
