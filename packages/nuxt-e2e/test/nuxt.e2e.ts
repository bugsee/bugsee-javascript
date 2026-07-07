// Real-Nuxt boot e2e for @bugsee/nuxt.
//
// Builds the fixture Nuxt app (nuxi build → a node-server .output) and boots it in a REAL separate node
// process pointed at a mock collector, then asserts the actual wire output:
//   • hitting the throwing server route (/api/boom) makes Nitro fire its `error` hook → @bugsee/nuxt's
//     installed Nitro plugin reports it → a bundle with the error uploads to the collector;
//   • the SSR HTML of the index page carries the injected `<meta name="traceparent">` (U5, FE↔BE join).
//
// This is the integration layer the unit tests can't reach: it proves the module actually wires into a
// real Nuxt/Nitro build so a route throw becomes a delivered report.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockCollector, startMockCollector } from './collector';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(appDir, '.output', 'server', 'index.mjs');

interface ReportEnvelope {
  type: string;
  summary?: string;
  source?: { mechanism?: string };
}
interface ParsedBundle {
  files: Record<string, Uint8Array>;
  request: ReportEnvelope;
}

const parseBundles = (collector: MockCollector): ParsedBundle[] =>
  collector.uploads.map((u) => {
    const files = unzipSync(u.body) as Record<string, Uint8Array>;
    return { files, request: JSON.parse(strFromU8(files['request.json'] as Uint8Array)) };
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `predicate` holds or the deadline passes. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  stepMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

/** Poll a URL until it answers OK or the deadline passes. */
async function probeUntilUp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  return false;
}

describe('@bugsee/nuxt — real Nuxt boot e2e', () => {
  let collector: MockCollector;
  let server: ChildProcess;
  const port = 3737;
  const base = `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    collector = await startMockCollector();

    // Build the fixture app (node-server preset). Idempotent; ~seconds.
    const build = spawnSync('pnpm', ['exec', 'nuxi', 'build'], { cwd: appDir, encoding: 'utf8' });
    if (build.status !== 0) {
      throw new Error(`nuxi build failed:\n${build.stdout}\n${build.stderr}`);
    }

    // Boot the built node server, pointed at the collector via the runtimeConfig env override.
    server = spawn('node', [serverEntry], {
      cwd: appDir,
      env: {
        ...process.env,
        NUXT_BUGSEE_ENDPOINT: collector.url,
        NUXT_PUBLIC_BUGSEE_ENDPOINT: collector.url,
        PORT: String(port),
        NITRO_PORT: String(port),
        HOST: '127.0.0.1',
        NITRO_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr?.on('data', (d: Buffer) => process.stderr.write(`[nuxt-server] ${d}`));

    // Wait until the server answers a request.
    const up = await probeUntilUp(`${base}/`, 60_000);
    if (!up) throw new Error('nuxt server did not come up');
  });

  afterAll(async () => {
    server?.kill('SIGKILL');
    await collector?.close();
  });

  it('injects the trace <meta> into the SSR HTML of a page (U5, FE↔BE join)', async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<meta name="traceparent"');
  });

  it('reports a thrown server route as an uploaded bundle (moat server-error path)', async () => {
    const res = await fetch(`${base}/api/boom`);
    expect(res.status).toBe(500); // the route really threw

    const got = await waitFor(() => collector.uploads.length > 0, 30_000);
    expect(got).toBe(true);

    const bundles = parseBundles(collector);
    expect(bundles.length).toBeGreaterThan(0);
    // The bundle was reported with OUR mechanism (installBugseeNitro → reportServerError 'http-error').
    const errorBundle = bundles.find((b) => b.request.source?.mechanism === 'http-error');
    expect(errorBundle, 'a bundle reported with mechanism http-error').toBeDefined();
    // …and it actually carries the thrown message (not an empty/placeholder report).
    const allText = Object.values((errorBundle as ParsedBundle).files)
      .map((f) => strFromU8(f))
      .join('\n');
    expect(allText).toContain('e2e nitro boom');
    // The collector minted a session + issue for it (full control-plane round trip).
    expect(collector.sessions.length).toBeGreaterThan(0);
    expect(collector.issues.length).toBeGreaterThan(0);
  });
});
