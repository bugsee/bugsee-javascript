import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

export default defineConfig([
  baseConfig,
  {
    // `bugsee-sourcemaps-doctor`: an ESM-only executable (its entry guard reads `import.meta.url`, which a CJS
    // build does not have). `clean: false` so it does not wipe the library build above.
    ...baseConfig,
    entry: ['src/doctor-cli.ts'],
    format: ['esm'],
    dts: false,
    clean: false,
  },
]);
