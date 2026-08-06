// WAVE 4.4 — the ZERO-CONFIG Cloudflare deploy path, which is the one Nuxt's own docs advertise.
//
// The module chose the node-vs-edge Nitro plugin from `nuxt.options.nitro?.preset` at MODULE-SETUP time.
// That value is only populated when the user writes `nitro: { preset }` in `nuxt.config.ts` or passes an
// explicit override. Nitro's AUTO-DETECTION resolves the preset inside `createNitro()`, long after modules
// have run — so on Cloudflare Pages/Workers the module saw `undefined`, concluded "not edge", and shipped
// `@bugsee/bugsee/node` into a workerd bundle.
//
// Measured on the real build before the fix, with the same fixture:
//   PROBE SETUP      nuxt.options.nitro?.preset = undefined
//   PROBE NITRO:INIT nitro.options.preset       = "cloudflare-pages"
//
// The existing edge-build e2e passes only because it SETS `NITRO_PRESET`, which @nuxt/cli forwards as an
// explicit override — so it exercises the one path where the bug cannot appear. This file deliberately
// leaves the preset unset and lets Nitro detect it, which is what a customer's CI does.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const workerBundle = join(appDir, 'dist', '_worker.js', 'chunks', 'nitro', 'nitro.mjs');

describe('@bugsee/nuxt — auto-detected Cloudflare preset (Wave 4.4)', () => {
  let bundle = '';

  beforeAll(() => {
    rmSync(join(appDir, 'dist'), { recursive: true, force: true });
    rmSync(join(appDir, '.nuxt'), { recursive: true, force: true });
    const { NITRO_PRESET, SERVER_PRESET, ...env } = process.env;
    const build = spawnSync('pnpm', ['exec', 'nuxi', 'build'], {
      cwd: appDir,
      encoding: 'utf8',
      // No preset given — Nitro must detect `cloudflare-pages` from the CF_PAGES marker, exactly as it
      // does in a real Cloudflare Pages CI environment.
      env: { ...env, CF_PAGES: '1', CF_PAGES_URL: 'https://x.pages.dev' },
    });
    if (build.status !== 0) {
      throw new Error(`cloudflare build failed:\n${build.stdout}\n${build.stderr}`);
    }
    if (!existsSync(workerBundle)) {
      throw new Error(`worker bundle not found at ${workerBundle}`);
    }
    bundle = readFileSync(workerBundle, 'utf8');
  });

  afterAll(() => {
    rmSync(join(appDir, 'dist'), { recursive: true, force: true });
  });

  it('detected the Cloudflare preset at all — the fixture really did take the auto path', () => {
    // Without this the whole file could pass against a build that silently fell back to `node-server`.
    expect(existsSync(workerBundle)).toBe(true);
  });

  it('ships the EDGE install into the worker bundle', () => {
    expect(bundle).toContain('installBugseeNitroEdge');
  });

  it('does NOT ship the NODE install into the worker bundle', () => {
    expect(bundle.includes('installBugseeNitro(')).toBe(false);
  });

  it('does not drag node-only machinery into a workerd bundle', () => {
    // The concrete cost of shipping the node composition here: fs storage, the worker-thread ANR watchdog,
    // and `process.uptime()` in the env builder — none of which exist in workerd.
    for (const marker of [
      "import('node:fs')",
      "import('node:worker_threads')",
      'process.uptime()',
    ]) {
      expect(bundle.includes(marker), `the worker bundle carries \`${marker}\``).toBe(false);
    }
  });
});
