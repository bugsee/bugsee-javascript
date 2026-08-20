// The scripted scenario sweep (§6 of docs/samples/PLAN.md). Boots the service with a wire-tap
// transport, drives every HTTP-triggerable scenario with a unique marker, gives the fire-and-forget
// uploads time to leave the process, then prints a LOCAL / WIRE pass-fail table and writes
// data/verify-run.json (scenario -> marker -> timestamp) for cross-referencing against the backend by
// hand (see scripts/README in scenarios.md and FINDINGS.md — backend delivery is currently blocked by
// a staging-side gap, F-1, so this script cannot assert BACKEND arrival itself).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = join(import.meta.dirname, '..');
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const wireLog = join(dataDir, `verify-wire-${Date.now()}.ndjson`);
writeFileSync(wireLog, '');
const port = Number(process.env.PORT ?? 5305);
const runId = Date.now();

interface Scenario {
  id: string;
  path: string;
  marker: string;
}

const scenarios: Scenario[] = [];
function s(id: string, path: string): void {
  const marker = `v${runId}-${id}`;
  scenarios.push({ id, path: path.replace('{marker}', marker), marker });
}

s('S1-isLaunched', '/scenario/s1/isLaunched');
s('S1-relaunch-ignored', '/scenario/s1/relaunch-ignored');
s('S2-identity-attributes', '/scenario/s2?marker={marker}');
s('S3-telemetry', '/scenario/s3?marker={marker}');
s('S4-error', '/scenario/s4/error?marker={marker}');
s('S4-string', '/scenario/s4/string?marker={marker}');
s('S4-object', '/scenario/s4/object?marker={marker}');
s('S4-null', '/scenario/s4/null?marker={marker}');
s('S4-cause', '/scenario/s4/cause?marker={marker}');
s('S4-dedupe', '/scenario/s4/dedupe?marker={marker}&sync=1');
s('S4-storm', '/scenario/s4/storm?marker={marker}');
s('S6-console', '/scenario/s6?marker={marker}');
s('S7-get', '/scenario/s7/get?marker={marker}');
s('S7-post', '/scenario/s7/post?marker={marker}');
s('S7-post-text', '/scenario/s7/post-text?marker={marker}');
s('S7-4xx', '/scenario/s7/4xx?marker={marker}');
s('S7-5xx', '/scenario/s7/5xx?marker={marker}');
s('S7-fail', '/scenario/s7/fail?marker={marker}');
s('S7-bigbody', '/scenario/s7/bigbody?marker={marker}');
s('S7-notype', '/scenario/s7/notype?marker={marker}');
s('S7-ws', '/scenario/s7/ws?marker={marker}');
s('S8-filters', '/scenario/s8?marker={marker}');
s('S9-performance', '/scenario/s9?marker={marker}');
s('S13-consume', '/scenario/s13-consume?marker={marker}');

interface Result {
  id: string;
  marker: string;
  httpOk: boolean;
  status?: number;
  body?: unknown;
  error?: string;
}

async function main(): Promise<void> {
  console.log(`[verify] starting service on port ${port}, wire log ${wireLog}`);
  const proc = spawn(process.execPath, ['src/server.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), BUGSEE_WIRE_LOG: wireLog, BUGSEE_PROFILE: 'default' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout?.on('data', (d) => (out += d.toString()));
  proc.stderr?.on('data', (d) => (out += d.toString()));

  const end = Date.now() + 20000;
  let healthy = false;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await delay(200);
  }
  if (!healthy) {
    console.error('[verify] service did not become healthy\n' + out);
    proc.kill('SIGKILL');
    process.exitCode = 1;
    return;
  }
  console.log('[verify] service healthy — running scenarios');

  const results: Result[] = [];
  for (const sc of scenarios) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${sc.path}`, { signal: AbortSignal.timeout(15000) });
      let body: unknown;
      try {
        body = await r.json();
      } catch {
        body = undefined;
      }
      results.push({ id: sc.id, marker: sc.marker, httpOk: r.ok, status: r.status, body });
    } catch (error) {
      results.push({ id: sc.id, marker: sc.marker, httpOk: false, error: (error as Error).message });
    }
  }

  console.log('[verify] scenarios triggered — giving fire-and-forget uploads time to reach the wire');
  await delay(8000);
  await fetch(`http://127.0.0.1:${port}/admin/flush?timeout=5000`).catch(() => {});
  await delay(500);

  proc.kill('SIGTERM');
  await delay(1000);
  proc.kill('SIGKILL');

  // WIRE-level check (§4 depth 2): did a request carrying this marker leave the process at all? We
  // check both the SDK's own outbound control-plane traffic (wireLog, via BUGSEE_WIRE_LOG) and the
  // app's own loopback fetches (echoed back in the scenario's own JSON response body).
  const wireLines = existsSync(wireLog)
    ? readFileSync(wireLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { requestBody: string | null })
    : [];
  const wireText = wireLines.map((l) => l.requestBody ?? '').join('\n');

  const table = results.map((r) => {
    const wireHit = wireText.includes(r.marker) || JSON.stringify(r.body ?? '').includes(r.marker);
    return {
      id: r.id,
      local: r.httpOk ? 'PASS' : `FAIL (${r.error ?? r.status})`,
      wire: wireHit ? 'PASS' : 'no-evidence',
      backend: 'BLOCKED (see FINDINGS.md F-1)',
    };
  });

  console.log('\n' + '='.repeat(100));
  console.log('SCENARIO'.padEnd(28) + 'LOCAL'.padEnd(20) + 'WIRE'.padEnd(16) + 'BACKEND');
  console.log('-'.repeat(100));
  for (const row of table) {
    console.log(row.id.padEnd(28) + row.local.padEnd(20) + row.wire.padEnd(16) + row.backend);
  }
  console.log('='.repeat(100));
  const passLocal = table.filter((r) => r.local === 'PASS').length;
  console.log(`\n[verify] LOCAL: ${passLocal}/${table.length} passed`);
  console.log(`[verify] wire log: ${wireLog} (${wireLines.length} SDK control-plane request(s) captured)`);
  console.log(`[verify] server output tail:\n${out.split('\n').slice(-20).join('\n')}`);

  writeFileSync(
    join(dataDir, 'verify-run.json'),
    JSON.stringify({ runId, port, wireLog, results, table }, null, 2),
  );

  if (passLocal !== table.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[verify] failed', error);
  process.exitCode = 1;
});
