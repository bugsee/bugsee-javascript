import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// tsup builds the entries below in PARALLEL, so neither may clean `dist` (a clean that runs after the other entry's
// write would delete it and the build would still succeed). The package `build` script empties `dist` first instead.
export default defineConfig([
  { ...baseConfig, clean: false },
  {
    // `bugsee-sourcemaps-doctor`: an ESM-only executable (its entry guard reads `import.meta.url`, which a CJS
    // build does not have).
    ...baseConfig,
    entry: ['src/doctor-cli.ts'],
    format: ['esm'],
    dts: false,
    clean: false,
  },
]);
