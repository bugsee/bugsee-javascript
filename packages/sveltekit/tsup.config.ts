import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/sveltekit: the portable `.` entry (handleError + handle + trace) — server/client/edge entries are
// added as their slices land.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
});
