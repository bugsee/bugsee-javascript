import node from '@astrojs/node';
import { bugsee } from '@bugsee/astro';
import { defineConfig } from 'astro/config';

// SSR fixture on the node adapter. The Integration inlines the server config into the generated
// server-middleware module AT BUILD TIME, so the collector endpoint (only known at test time) is read from
// the env HERE and baked in — the e2e sets BUGSEE_ENDPOINT before building. Lean, deterministic capture.
export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [
    bugsee({
      appToken: 'e2e-token',
      server: {
        endpoint: process.env.BUGSEE_ENDPOINT,
        capturedDataStore: 'memory',
        detectHangs: false,
        captureSystemTraces: false,
        captureSystemEvents: false,
      },
    }),
  ],
  // The @bugsee/* + bugsee packages are TS SOURCE in the workspace — Vite must bundle+transpile them for SSR.
  vite: { ssr: { noExternal: [/@bugsee\//, 'bugsee'] } },
});
