// Real-Nuxt EDGE build e2e for @bugsee/nuxt.
//
// Builds the fixture for the Nitro `vercel-edge` preset and asserts the module shipped the EDGE path: the
// edge function bundle carries our `installBugseeNitroEdge` + the edge SDK (`launchEdge`), and does NOT
// carry the node core (`installBugseeNitro`) or the `node:http` server emit-patch. This proves the U6
// build-time preset branch works in a real Nuxt edge build (the edge-SDK composition + the correct-SDK
// bundling). A full edge-VM boot+report is a further step; the report path itself is unit-tested in
// @bugsee/nuxt (nitro-edge.test.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const edgeEntry = join(appDir, '.vercel', 'output', 'functions', '__fallback.func', 'index.mjs');

describe('@bugsee/nuxt — real Nuxt edge (vercel-edge) build e2e', () => {
  let bundle = '';

  beforeAll(() => {
    const build = spawnSync('pnpm', ['exec', 'nuxi', 'build'], {
      cwd: appDir,
      encoding: 'utf8',
      env: { ...process.env, NITRO_PRESET: 'vercel_edge' },
    });
    if (build.status !== 0) throw new Error(`edge build failed:\n${build.stdout}\n${build.stderr}`);
    if (!existsSync(edgeEntry)) throw new Error(`edge bundle not found at ${edgeEntry}`);
    bundle = readFileSync(edgeEntry, 'utf8');
  });

  afterAll(() => {
    rmSync(join(appDir, '.vercel'), { recursive: true, force: true });
  });

  it('ships the EDGE install + edge SDK into the edge function bundle', () => {
    expect(bundle).toContain('installBugseeNitroEdge');
    expect(bundle).toContain('launchEdge'); // the @bugsee/vercel-edge composition root
  });

  it('does NOT bundle the node path (node core / node:http emit-patch) into the edge function', () => {
    // The node server-error core must be absent…
    expect(bundle.includes('installBugseeNitro(')).toBe(false);
    // …and the node:http Server.prototype.emit patch (node-only server instrumentation) must not be pulled in.
    expect(bundle.includes('Server.prototype.emit')).toBe(false);
  });
});
