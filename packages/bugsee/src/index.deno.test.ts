import { describe, expect, it } from 'vitest';

// The umbrella's `deno` export condition exists only to fail loudly. Deno sets `node` too, so without this
// entry it would silently resolve the node build (wrong runtime identity, uninstrumented `Deno.serve`).
describe('the unsupported Deno entry', () => {
  it('throws a clear error on import instead of exposing a launch()', async () => {
    await expect(import('./index.deno')).rejects.toThrow(/Deno is no longer supported/);
  });
});
