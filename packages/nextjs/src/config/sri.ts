// Subresource Integrity (`experimental.sri`) and what stamping may do about it, in one place.
//
// Turbopack hashes its output BEFORE the post-build hook runs, so stamping afterwards breaks the page (measured:
// every `integrity` wrong). webpack stamps inside the compilation, before anything hashes, so a stamp that took is
// safe; but a stamp that FAILED and falls back to stamping after emit is not (measured on Next 16.4.6 --webpack:
// the fallback rewrote real bundles and Chromium blocked every script, "Failed to find a valid digest"). The core's
// own SRI scan only sees HTML under the output directory, and Next keeps the integrity manifest elsewhere.
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  for (const candidate of [
    join(outDir, SRI_MANIFEST),
    join(outDir, name),
    join(dirname(outDir), name),
  ]) {
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

/** A webpack in-build stamp failed on an SRI build: the post-emit fallback would break the page. */
export const FALLBACK_SRI_NOTICE = (kind: string): string =>
  `the ${kind} build uses Subresource Integrity (\`experimental.sri\`) and its in-build debug-ID stamp did not apply, so stamping after emit (which would invalidate the pinned hashes and make the browser refuse the scripts) was skipped. Source maps were NOT uploaded for it. ${PUBLIC_MAPS}`;

/** Turbopack on a Next without the post-build hook. */
export const NO_HOOK_NOTICE = (version: string): string =>
  `Next ${version} builds with Turbopack but has no post-build hook to upload from; source maps were NOT uploaded. Upgrade to Next 15.4.0 or later, or build with webpack. Bugsee did not turn browser source maps on for this build.`;
