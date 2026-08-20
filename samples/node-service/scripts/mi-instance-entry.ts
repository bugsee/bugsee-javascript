// Shared entry for one multi-instance-coexistence participant (S12 cluster test). Runs either as a
// worker_thread (spawned by scripts/multi-instance.ts with workerData) or as a standalone OS process
// (spawned via child_process with env vars) — same launch, same behaviour, so the "3 worker_threads +
// a second process share one dataDir" setup in docs/samples/PLAN.md §5.13 is literally one code path
// instantiated 4 ways.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { buildOptions } from '../src/bugsee-client.ts';
import { launch } from '@bugsee/bugsee/node';

interface Config {
  label: string;
  marker: string;
  dataDir: string;
}

const config: Config = isMainThread
  ? { label: process.env.MI_LABEL as string, marker: process.env.MI_MARKER as string, dataDir: process.env.MI_DATA_DIR as string }
  : (workerData as Config);

process.env.BUGSEE_DATA_DIR = config.dataDir;
const { options } = buildOptions('default');
const client = launch(process.env.BUGSEE_APP_TOKEN as string, options);
client.launch();
client.setAttribute('mi.label', config.label);
client.setAttribute('mi.marker', config.marker);

async function main(): Promise<void> {
  // Fire-and-forget: the upload itself is not what this scenario proves (see FINDINGS.md — the
  // javascript app-type gate blocks it regardless), and awaiting it would stall 'ready' for the
  // duration of the SDK's full retry+backoff cycle. What matters here is that the pending-report
  // MARKER is written synchronously to the per-instance subtree before assembly (client.ts
  // submitReport) — that's what a killed sibling leaves behind for recovery to find.
  client
    .logException(new Error(`multi-instance participant ${config.label} marker=${config.marker}`), {
      labels: ['scenario:s12-multi-instance', `label:${config.label}`],
    })
    .catch(() => {});
  const say = (msg: string): void => {
    if (isMainThread) {
      console.log(`[mi:${config.label}] ${msg}`);
    } else {
      parentPort?.postMessage({ type: 'log', msg });
    }
  };
  say('ready');

  const heartbeat = setInterval(() => {
    client.addBreadcrumb({ category: 'mi', message: `heartbeat ${config.label}`, level: 'info' });
  }, 500);
  heartbeat.unref();

  if (!isMainThread) {
    parentPort?.on('message', (m: { type: string }) => {
      if (m.type === 'stop') {
        clearInterval(heartbeat);
        void client.stop(3000).then(() => parentPort?.postMessage({ type: 'stopped' }));
      }
    });
    parentPort?.postMessage({ type: 'ready' });
  } else {
    console.log(`READY ${config.label}`);
  }
}

void main();
