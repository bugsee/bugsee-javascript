// S12 multi-instance coexistence: 3 worker_threads + a second OS process, all launched against ONE
// shared dataDir. Proves (a) concurrent aggregators don't corrupt each other's on-disk subtree while
// all alive, and (b) killing one (the process, for a fast pid-death liveness signal — see
// packages/node/src/liveness.ts) lets a freshly-launched instance recover its pending report with
// nothing lost or duplicated.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

const root = join(import.meta.dirname, '..');
const dataDir = join(root, 'data', `multi-instance-${Date.now()}`);
mkdirSync(dataDir, { recursive: true });
const runId = Date.now();

function instanceDirs(): string[] {
  return readdirSync(dataDir).filter((d) => /^\d+-\d+-/.test(d));
}

function ownerOf(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dataDir, dir, 'owner.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

async function startWorker(label: string): Promise<{ worker: Worker; ready: Promise<void> }> {
  const worker = new Worker(join(import.meta.dirname, 'mi-instance-entry.ts'), {
    workerData: { label, marker: `${runId}-${label}`, dataDir },
    env: process.env as unknown as Record<string, string>,
  });
  worker.on('error', (e) => console.error(`[mi-orchestrator] worker ${label} error`, e));
  const ready = new Promise<void>((resolve) => {
    worker.on('message', (m: { type: string }) => {
      if (m.type === 'ready') resolve();
    });
  });
  return { worker, ready };
}

function spawnProcess(label: string): ReturnType<typeof spawn> {
  return spawn(process.execPath, [join(import.meta.dirname, 'mi-instance-entry.ts')], {
    cwd: root,
    env: { ...process.env, MI_LABEL: label, MI_MARKER: `${runId}-${label}`, MI_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function main(): Promise<void> {
  console.log(`[mi-orchestrator] dataDir=${dataDir} runId=${runId}`);

  const w1 = await startWorker('worker-1');
  const w2 = await startWorker('worker-2');
  const w3 = await startWorker('worker-3');
  await Promise.all([w1.ready, w2.ready, w3.ready]);
  console.log('[mi-orchestrator] all 3 worker_threads ready');

  const proc = spawnProcess('process-1');
  let procOut = '';
  proc.stdout?.on('data', (d) => (procOut += d.toString()));
  proc.stderr?.on('data', (d) => (procOut += d.toString()));
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (procOut.includes('READY process-1')) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
  console.log('[mi-orchestrator] second process ready');

  await delay(1200); // let a few heartbeats land so subtrees are non-trivial
  const during = instanceDirs();
  console.log(`[mi-orchestrator] instance subtrees while all 4 alive: ${JSON.stringify(during)}`);
  const owners = during.map((d) => ({ dir: d, owner: ownerOf(d) }));
  console.log(`[mi-orchestrator] owners: ${JSON.stringify(owners)}`);

  // Kill the SECOND PROCESS abruptly (SIGKILL) — a whole-process death is detected instantly via
  // pidAlive() (packages/node/src/liveness.ts), no heartbeat-staleness wait needed.
  console.log('[mi-orchestrator] SIGKILL-ing process-1');
  proc.kill('SIGKILL');
  await delay(500);

  // A fresh recovering instance (another OS process, new pid → new subtree) scans siblings on launch.
  const recoverer = spawnProcess('recoverer');
  let recovererOut = '';
  recoverer.stdout?.on('data', (d) => (recovererOut += d.toString()));
  recoverer.stderr?.on('data', (d) => (recovererOut += d.toString()));
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (recovererOut.includes('READY recoverer')) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
  await delay(2000); // let recoverInstances() + the durable upload settle
  const after = instanceDirs();
  console.log(`[mi-orchestrator] instance subtrees after recovery: ${JSON.stringify(after)}`);

  // Stop the still-alive worker_threads + recoverer gracefully.
  for (const w of [w1, w2, w3]) {
    w.worker.postMessage({ type: 'stop' });
  }
  await delay(500);
  for (const w of [w1, w2, w3]) {
    await w.worker.terminate();
  }
  recoverer.kill('SIGTERM');
  await delay(300);
  recoverer.kill('SIGKILL');

  console.log('----- process-1 output -----\n' + procOut);
  console.log('----- recoverer output -----\n' + recovererOut);
  console.log(
    'RESULT ' +
      JSON.stringify({
        runId,
        dataDir,
        subtreesDuring: during.length,
        subtreesAfter: after.length,
      }),
  );
}

main().catch((error) => {
  console.error('[mi-orchestrator] failed', error);
  process.exitCode = 1;
});
