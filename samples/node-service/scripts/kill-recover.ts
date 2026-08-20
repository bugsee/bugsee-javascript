// S12 persistence & recovery, disk-capture flavour: SIGKILL the service mid-capture, then restart it
// pointed at the SAME dataDir and confirm the pending report is recovered + uploaded. Node process
// management (spawn/kill), so it runs as its own script rather than an HTTP route.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = join(import.meta.dirname, '..');
const dataDir = join(root, 'data', `kill-recover-${Date.now()}`);
mkdirSync(dataDir, { recursive: true });
const marker = `killrecover-${Date.now()}`;
const port = Number(process.env.PORT ?? 5399);

function spawnServer(env: Record<string, string>): ReturnType<typeof spawn> {
  return spawn(process.execPath, ['src/server.ts'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForHealth(timeoutMs = 15000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(150);
  }
  throw new Error('server did not become healthy in time');
}

async function main(): Promise<void> {
  console.log(`[kill-recover] dataDir=${dataDir} marker=${marker} port=${port}`);

  const envBase = {
    PORT: String(port),
    BUGSEE_DATA_DIR: dataDir,
    BUGSEE_PROFILE: 'default',
    LINKS_FILE: join(dataDir, 'links.json'),
  };

  const proc1 = spawnServer(envBase);
  let out1 = '';
  proc1.stdout?.on('data', (d) => (out1 += d.toString()));
  proc1.stderr?.on('data', (d) => (out1 += d.toString()));
  await waitForHealth();

  // Fire the crash-worthy event WITHOUT waiting for the response (the marker write happens
  // synchronously inside submitReport, before assembly/upload) — then kill almost immediately.
  fetch(`http://127.0.0.1:${port}/scenario/s4/error?marker=${marker}`).catch(() => {});
  await delay(120);
  proc1.kill('SIGKILL');
  await delay(300);

  const instanceDirs = readdirSync(dataDir).filter((d) => /^\d+-\d+-/.test(d));
  console.log(`[kill-recover] instance subtrees after SIGKILL: ${JSON.stringify(instanceDirs)}`);

  // Restart pointed at the SAME dataDir — a fresh pid means a NEW instance subtree, so on launch this
  // instance's recoverInstances() scan finds the killed one as a DEAD sibling (pidAlive() is false
  // immediately — no heartbeat-staleness wait needed) and recovers its pending report.
  const proc2 = spawnServer(envBase);
  let out2 = '';
  proc2.stdout?.on('data', (d) => (out2 += d.toString()));
  proc2.stderr?.on('data', (d) => (out2 += d.toString()));
  await waitForHealth();
  await delay(1500); // let the async recoverInstances() scan + upload settle
  await fetch(`http://127.0.0.1:${port}/admin/flush?timeout=8000`).catch(() => {});
  await delay(500);

  const instanceDirsAfter = existsSync(dataDir) ? readdirSync(dataDir).filter((d) => /^\d+-\d+-/.test(d)) : [];
  console.log(`[kill-recover] instance subtrees after recovery: ${JSON.stringify(instanceDirsAfter)}`);

  proc2.kill('SIGTERM');
  await delay(500);
  proc2.kill('SIGKILL');

  console.log('----- instance 1 output -----');
  console.log(out1);
  console.log('----- instance 2 output -----');
  console.log(out2);
  console.log(
    'RESULT ' +
      JSON.stringify({
        marker,
        dataDir,
        instanceDirsBefore: instanceDirs.length,
        instanceDirsAfter: instanceDirsAfter.length,
      }),
  );
}

main().catch((error) => {
  console.error('[kill-recover] failed', error);
  process.exitCode = 1;
});
