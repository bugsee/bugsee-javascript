import { defineConfig } from 'vitest/config';

// No product code here and therefore no coverage gate: this package only exercises @bugsee/opentelemetry
// against the real OpenTelemetry JS 3.x SDK, so it runs under `turbo run test:unit`.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
