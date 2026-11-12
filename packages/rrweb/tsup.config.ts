import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';
import {
  dedupeTrailingSourceMap,
  stripInlineSourceMapPlugin,
} from './build/strip-inline-sourcemap';

// The guard test builds into a temp dir (BUGSEE_RRWEB_OUT_DIR + `--out-dir`) so it never cleans the real
// dist/ while a concurrent turbo `build` is writing it.
const outDir = process.env.BUGSEE_RRWEB_OUT_DIR ?? 'dist';

// @bugsee/rrweb: the thin record-path wrapper.
//
// `@bugsee/rrweb-record` — the prebuilt, record-only fork bundle — is BUNDLED IN rather than left as a
// dependency. It was a git dependency on a private repository, which made every browser-family package
// uninstallable for a customer: pnpm 11 refuses an exotic dependency in a subdependency by default
// (`ERR_PNPM_EXOTIC_SUBDEP`), and even with that disabled it needs git access to a repo they cannot
// reach. Inlining ~62 KB gzip of record path into the one package whose whole purpose is to be that
// record path is the honest trade. The rrweb TYPE packages stay external — type imports are erased.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
  noExternal: ['@bugsee/rrweb-record'],
  // The vendored bundle inlines a worker as a template literal ending in a sourceMappingURL comment; see
  // strip-inline-sourcemap.ts (Angular's esbuild builder would otherwise cut the closing backtick).
  // Exactly one inlined comment exists in the vendored bundle (the image-bitmap worker); any other count
  // means a vendor bump changed it and this transform needs a look.
  esbuildPlugins: [stripInlineSourceMapPlugin({ expected: 1 })],
  // tsup writes the trailing `//# sourceMappingURL=` twice; keep one so the file has exactly one, last.
  onSuccess: async () => {
    for (const name of ['index.js', 'index.cjs']) {
      const f = join(outDir, name);
      writeFileSync(f, dedupeTrailingSourceMap(readFileSync(f, 'utf8')));
    }
  },
});
