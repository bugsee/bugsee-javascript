// Subresource Integrity (`experimental.sri`) and what stamping may do about it, in one place.
//
// Turbopack hashes its output BEFORE the post-build hook runs, so stamping afterwards breaks the page (measured:
// every `integrity` wrong). webpack stamps inside the compilation, before anything hashes, so a stamp that took is
// safe; but a stamp that FAILED and falls back to stamping after emit is not (measured on Next 16.4.6 --webpack:
// the fallback rewrote real bundles and Chromium blocked every script, "Failed to find a valid digest"). The core's
// own SRI scan only sees HTML under the output directory, and Next keeps the integrity manifest elsewhere.
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Where Next records the integrity hashes it pinned, relative to the dist directory. */
export const SRI_MANIFEST = join('server', 'subresource-integrity-manifest.json');

/** Whether a path is an existing file. */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Whether an integrity manifest sits next to a webpack compilation's output (client `.next`, server `.next/server/chunks`, edge `.next/server`). */
export async function sriManifestNear(
  outDir: string,
  exists: (path: string) => Promise<boolean> = isFile,
): Promise<boolean> {
  const name = 'subresource-integrity-manifest.json';
  // The manifest lives in `<dist>/server`. A file of that name anywhere else is not Next's.
  const candidates = [join(outDir, SRI_MANIFEST)];
  if (basename(outDir) === 'server') {
    candidates.push(join(outDir, name));
  }
  if (basename(dirname(outDir)) === 'server') {
    candidates.push(join(dirname(outDir), name));
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return true;
    }
  }
  return false;
}

const PUBLIC_MAPS =
  'Browser source maps, if Next emits any (`productionBrowserSourceMaps`), stay in `.next/static` and are publicly served.';

/** Turbopack + SRI: not stampable, so nothing is uploaded. */
export const TURBOPACK_SRI_NOTICE = `this build uses Subresource Integrity (\`experimental.sri\`). Turbopack hashes its output before the post-build hook runs, so stamping debug-IDs now would make the browser refuse the scripts. Source maps were NOT uploaded and the build was left unmodified. Build with \`next build --webpack\` to upload source maps for an SRI build. ${PUBLIC_MAPS}`;

/**
 * A webpack in-build stamp failed on an SRI build: the post-emit fallback would break the page, so nothing is
 * stamped or uploaded. `mapsRemoved`: the browser maps Bugsee itself had turned on were deleted again, so they are
 * not left public; otherwise (the app asked for them) they stay, and the notice says so.
 */
export const FALLBACK_SRI_NOTICE = (
  kind: string,
  mapsRemoved: boolean,
  options: { dryRun?: boolean; removalFailed?: boolean; retained?: boolean } = {},
): string =>
  `the ${kind} build uses Subresource Integrity (\`experimental.sri\`) and its in-build debug-ID stamp did not apply (the reason is reported separately), so nothing was stamped or uploaded: stamping after emit would invalidate the pinned hashes and make the browser refuse the scripts.` +
  (kind !== 'client'
    ? ''
    : mapsRemoved
      ? ' The browser source maps Bugsee had turned on were removed from `.next/static`.'
      : options.dryRun === true
        ? ` Dry run: nothing was deleted. ${PUBLIC_MAPS}`
        : options.retained === true
          ? ` \`deleteMaps: false\` keeps the browser source maps Bugsee turned on. ${PUBLIC_MAPS}`
          : options.removalFailed === true
            ? ` The browser maps Bugsee turned on could not all be removed. ${PUBLIC_MAPS}`
            : ` ${PUBLIC_MAPS}`);

/** Turbopack on a Next without the post-build hook. */
export const NO_HOOK_NOTICE = (version: string): string =>
  `Next ${version} builds with Turbopack but has no post-build hook to upload from; source maps were NOT uploaded. Upgrade to Next 15.4.0 or later, or build with webpack. Bugsee did not turn browser source maps on for this build.`;
