import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// Four outputs, because they run in four different places:
//   - the runtime entry and the `./sourcemaps` API: ESM + CJS + types (the base preset);
//   - the `bugsee-angular-upload` bin: ESM only (it uses top-level await), run by Node;
//   - the `ng add` schematic: CommonJS (`.cjs`), loaded by the Angular CLI, with its collection and schema JSON.
// `clean` is off in every one so they cannot delete each other's output; the build script clears dist first.
const shared = { ...baseConfig, clean: false } as const;

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts', 'sourcemaps/index': 'src/sourcemaps/index.ts' },
  },
  {
    ...shared,
    dts: false,
    format: ['esm'],
    platform: 'node',
    entry: { 'sourcemaps/bin': 'src/sourcemaps/bin.ts' },
  },
  {
    ...shared,
    dts: false,
    format: ['cjs'],
    platform: 'node',
    entry: { 'schematics/ng-add/index': 'src/schematics/ng-add/index.ts' },
    onSuccess: async () => {
      cpSync('src/schematics/collection.json', 'dist/schematics/collection.json');
      cpSync('src/schematics/ng-add/schema.json', 'dist/schematics/ng-add/schema.json');
    },
  },
]);
