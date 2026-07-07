import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/sveltekit: the portable `.` entry (handleError + handle + trace) + `server` (node launch) +
// `client` (browser launch + @bugsee/svelte). The edge entry is added with SK4.
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/server.ts', 'src/client.ts'],
});
