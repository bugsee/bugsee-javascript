// Vitest-free cross-version smoke. Boots the REAL SDK in the key scenarios via tsx — so it runs on EVERY
// Node version, including Node 18 where vitest 4 cannot even load (rolldown's node:util.styleText) — and
// asserts the uploaded bundles. Driven per Node version by scripts/test-matrix.sh. Exits 0 on all-pass,
// 1 otherwise. It deliberately covers the two paths that have had real version-specific bugs:
//   • worker  — off-thread disk capture (captureWriter:'worker') round-trips into the bundle,
//   • server  — an incoming request opens a per-request context (exercises the portable context-id minter).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from '@bugsee/util';
import { type MockCollector, startMockCollector } from './test/collector';
import { type RuntimeTarget, runScenarioProcess, runtimeTargets } from './test/runtimes';

interface SmokeBundle {
  files: Record<string, Uint8Array>;
  req: { summary?: string; context_id?: string };
}
const bundlesOf = (c: MockCollector): SmokeBundle[] =>
  c.uploads.map((u) => {
    const files = unzipSync(u.body) as Record<string, Uint8Array>;
    return { files, req: JSON.parse(strFromU8(files['request.json'] as Uint8Array)) };
  });
const logsOf = (b: SmokeBundle | undefined): Array<{ message?: string }> =>
  b?.files['logs.json'] ? JSON.parse(strFromU8(b.files['logs.json'])) : [];

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail });
};

async function main(): Promise<void> {
  const node = runtimeTargets().find((t) => t.name === 'node');
  if (node?.bin === undefined) {
    console.error('[smoke] no node/tsx target available');
    process.exit(1);
  }
  const target = node as RuntimeTarget & { bin: string };

  // worker: off-thread disk capture must round-trip into the delivered bundle.
  {
    const collector = await startMockCollector();
    const dataDir = mkdtempSync(join(tmpdir(), 'smoke-ww-'));
    const r = await runScenarioProcess(target, collector.url, 'worker', {
      BUGSEE_E2E_DATADIR: dataDir,
    });
    const bundle = bundlesOf(collector).find((b) => b.req.summary === 'e2e worker-writer failure');
    const logs = logsOf(bundle);
    check('worker: exits 0', r.exitCode === 0, r.stderr);
    check(
      'worker: off-thread capture is in the bundle',
      logs.some((l) => l.message?.includes('worker-writer breadcrumb')),
      `bundle=${bundle !== undefined} logs=${logs.length}`,
    );
    await collector.close();
    rmSync(dataDir, { recursive: true, force: true });
  }

  // server: an incoming request opens a per-request context (exercises the portable context-id minter).
  {
    const collector = await startMockCollector();
    const r = await runScenarioProcess(target, collector.url, 'server');
    const bundle = bundlesOf(collector).find((b) => b.req.summary === 'e2e server handler failure');
    check('server: exits 0', r.exitCode === 0, r.stderr);
    check(
      'server: report carries a context_id',
      typeof bundle?.req.context_id === 'string' && (bundle.req.context_id ?? '').length > 0,
      `bundle=${bundle !== undefined}`,
    );
    await collector.close();
  }

  let allOk = true;
  console.log(`\n[smoke] Node ${process.version}`);
  for (const r of results) {
    console.log(
      `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  — ${r.detail.slice(0, 200)}`}`,
    );
    if (!r.ok) {
      allOk = false;
    }
  }
  process.exit(allOk ? 0 : 1);
}

void main();
