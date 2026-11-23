// An SSR build's server modules embed the page, SRI hashes included, so re-sealing the browser directory alone leaves
// the server serving stale hashes (measured: every script blocked). When the output is named by its browser directory
// (`--dist`, or `--output-path` pointing at it) the output ROOT has to be found from it.
import { lstatSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

type PathApi = Pick<typeof path, 'relative' | 'isAbsolute' | 'sep' | 'join' | 'dirname'>;

/** Whether `dir` is strictly below `root` (not equal to it, not above it, not on another drive). */
export function isStrictlyInside(dir: string, root: string, api: PathApi = path): boolean {
  const rel = api.relative(root, dir);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

const isRealDirectory = (p: string): boolean => {
  try {
    const info = lstatSync(p);
    return info.isDirectory(); // lstat does not follow a symlink, so a symlinked server/ is not a directory here
  } catch {
    return false;
  }
};

/** Files an Angular SSR build writes to its server output (`server.mjs`, or the engine manifests and server entry). */
const ANGULAR_SERVER_FILE =
  /^(?:server|main\.server)\.mjs$|^index\.server\.html$|^angular-app(?:-engine)?-manifest\.mjs$/;

/** Whether `dir` looks like Angular's server output: a marker file in it, or in a locale directory of it. */
function looksLikeAngularServer(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) =>
      entry.isDirectory()
        ? readdirSync(path.join(dir, entry.name)).some((name) => ANGULAR_SERVER_FILE.test(name))
        : ANGULAR_SERVER_FILE.test(entry.name),
    );
  } catch {
    return false;
  }
}

/** How far above the output directory the root is looked for: `browser/` -> root, `browser/<locale>/` -> two. */
const MAX_LEVELS_UP = 2;

export type ServerRoot = { root: string; browser: string } | { notice: string } | undefined;

/**
 * The output root of the SSR build `outDir` belongs to: the nearest ancestor (at most {@link MAX_LEVELS_UP} up) that
 * has both a `browser/` containing `outDir` and a real (not symlinked) `server/`. Requiring the `browser/` sibling
 * keeps an unrelated `server/` from becoming the scope. A root that is the project itself, or outside it, is NOT
 * returned (re-sealing a project root, or someone else's directory, is not this tool's call): a notice says so.
 */
export function findServerRoot(outDir: string, cwd: string, api: PathApi = path): ServerRoot {
  let root = api.dirname(outDir);
  let unmatched: string | undefined;
  for (let level = 0; level < MAX_LEVELS_UP; level++, root = api.dirname(root)) {
    if (!isRealDirectory(api.join(root, 'server'))) {
      continue;
    }
    const browser = api.join(root, 'browser');
    if (outDir !== browser && !isStrictlyInside(outDir, browser, api)) {
      if (isStrictlyInside(root, cwd, api) && looksLikeAngularServer(api.join(root, 'server'))) {
        unmatched ??= api.join(root, 'server');
      }
      continue;
    }
    if (isStrictlyInside(root, cwd, api)) {
      return { root, browser };
    }
    return {
      notice:
        `found ${api.join(root, 'server')} next to the browser output, which embeds the page's integrity hashes, but ` +
        (root === cwd
          ? 'the output root is the project root'
          : 'the output root is outside the project') +
        `, so it was not re-sealed and a server-rendered page may keep stale hashes. Build into its own directory and ` +
        `pass --output-path <that directory>.`,
    };
  }
  if (unmatched === undefined) {
    return undefined;
  }
  return {
    notice:
      `found ${unmatched} near the output, but the output is not inside a browser/ directory next to it (a custom ` +
      `outputPath.browser name?), so it cannot tell which is the browser output and did not re-seal the server pages, ` +
      `which embed the page's integrity hashes. Pass --output-path <the output base directory>.`,
  };
}
