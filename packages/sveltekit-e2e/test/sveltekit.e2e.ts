// Real-SvelteKit boot e2e for @bugsee/sveltekit.
//
// Builds the fixture SvelteKit app (vite build → an adapter-node server) and boots it in a REAL separate
// node process pointed at a mock collector, then asserts the actual wire output:
//   • hitting the throwing endpoint (/api/boom) makes SvelteKit call `handleError` → @bugsee/sveltekit's
//     installed hook reports it → a bundle with the error uploads to the collector;
//   • the SSR HTML of the index page carries the injected `<meta name="traceparent">` (the `handle` hook's
//     transformPageChunk — FE↔BE join).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoContractViolations } from '@bugsee/e2e-kit';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockCollector, startMockCollector } from './collector';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(appDir, 'build', 'index.js');

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

describe('@bugsee/sveltekit — real SvelteKit boot e2e', () => {
  let collector: MockCollector;
  let server: ChildProcess;
  const port = 3738;
  const base = `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    collector = await startMockCollector();

    const build = spawnSync('pnpm', ['exec', 'vite', 'build'], { cwd: appDir, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`vite build failed:\n${build.stdout}\n${build.stderr}`);

    server = spawn('node', [serverEntry], {
      cwd: appDir,
      env: {
        ...process.env,
        BUGSEE_ENDPOINT: collector.url,
        PORT: String(port),
        HOST: '127.0.0.1',
        ORIGIN: base,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr?.on('data', (d: Buffer) => process.stderr.write(`[sveltekit-server] ${d}`));

    const up = await probeUntilUp(`${base}/`, 60_000);
    if (!up) throw new Error('sveltekit server did not come up');
  });

  afterAll(async () => {
    server?.kill('SIGKILL');
    await collector?.close();
  });

  it('injects the trace <meta> into the SSR HTML of a page (handle → transformPageChunk)', async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<meta name="traceparent"');
  });

  it('reports a thrown endpoint as an uploaded bundle (moat server-error path)', async () => {
    const res = await fetch(`${base}/api/boom`);
    expect(res.status).toBe(500); // the endpoint really threw

    const got = await waitFor(() => collector.uploads.length > 0, 30_000);
    expect(got).toBe(true);

    const bundles = parseBundles(collector);
    expect(bundles.length).toBeGreaterThan(0);
    const errorBundle = bundles.find((b) => b.request.source?.mechanism === 'http-error');
    expect(errorBundle, 'a bundle reported with mechanism http-error').toBeDefined();
    const allText = Object.values((errorBundle as ParsedBundle).files)
      .map((f) => strFromU8(f))
      .join('\n');
    expect(allText).toContain('e2e sveltekit boom');
    expect(collector.sessions.length).toBeGreaterThan(0);
    expect(collector.issues.length).toBeGreaterThan(0);
  });

  // WAVE V0 — the collector VALIDATES every upload against the shipped wire contract, and this is what
  // makes it count. Until the shared kit landed, this harness carried its own collector copy that did no
  // validation at all, so the entry-payload contract added in Wave 3b.2 (logs.json / network.json /
  // events.json — the files that carry the actual captured data) covered exactly one of the five suites.
  //
  // A violation the collector records but nobody asserts is the same false assurance as no check at all.
  it('emits nothing that violates the upload contract', () => {
    assertNoContractViolations(collector);
  });

  it('the contract check is NOT vacuous — a bundle really did arrive', () => {
    // An assertion over an empty set is the same false assurance as no assertion. Naming what arrived
    // keeps the coverage claim honest.
    expect(collector.uploads.length, 'no bundle reached the collector at all').toBeGreaterThan(0);
  });
});
