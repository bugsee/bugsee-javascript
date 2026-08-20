import { defineConfig } from 'vitest/config';

// The packaging guard reads manifests and the built dist off disk; no coverage gate applies (there is
// no product code here), so it runs under `turbo run test:unit` rather than `test:coverage`.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
