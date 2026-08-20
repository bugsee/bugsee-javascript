import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/rrweb: the thin record-path wrapper.
//
// `@bugsee/rrweb-record` — the prebuilt, record-only fork bundle — is BUNDLED IN rather than left as a
// dependency. It was a git dependency on a private repository, which made every browser-family package
// uninstallable for a customer: pnpm 11 refuses an exotic dependency in a subdependency by default
// (`ERR_PNPM_EXOTIC_SUBDEP`), and even with that disabled it needs git access to a repo they cannot
// reach. Inlining ~56 KB gzip of record path into the one package whose whole purpose is to be that
// record path is the honest trade. The rrweb TYPE packages stay external — type imports are erased.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
  noExternal: ['@bugsee/rrweb-record'],
});
