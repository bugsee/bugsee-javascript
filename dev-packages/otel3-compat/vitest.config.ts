import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// No product code here and therefore no coverage gate: this package only exercises @bugsee/opentelemetry and
// @bugsee/nextjs's OTel provider against the real OpenTelemetry JS 3.x SDK, so it runs under `turbo run test:unit`.
//
// `@bugsee/nextjs` resolves `@opentelemetry/*` from ITS OWN install (the 2.x dev copies), which would silently test
// the 2.x path. These aliases make every importer, including the real `packages/nextjs/src/otel-provider.ts`, see
// an app that has ONLY OpenTelemetry 3.x: this package's `api` and `sdk-trace`, and no `sdk-trace-base` (removed in 3.x).
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@opentelemetry\/sdk-trace-base$/,
        replacement: fileURLToPath(new URL('./test-support/absent-module.ts', import.meta.url)),
      },
      {
        find: /^@opentelemetry\/sdk-trace$/,
        replacement: require.resolve('@opentelemetry/sdk-trace'),
      },
      { find: /^@opentelemetry\/api$/, replacement: require.resolve('@opentelemetry/api') },
    ],
  },
  test: { include: ['src/**/*.test.ts'] },
});
