import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

// @bugsee/sveltekit: the portable `.` entry (handleError + handle + trace) + `server` (node launch) +
// `client` (browser launch + @bugsee/svelte) + `edge` (runInEdgeContext-wrapped handle).
export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts', 'src/server.ts', 'src/client.ts', 'src/edge.ts'],
});
