// Dual-module smoke test 1/4: ESM import of the UMBRELLA `@bugsee/bugsee/node` subpath. Plain JS (no
// TS), because a customer never sees the TS source — this proves the packed dist/exports map resolves
// under a real ESM `import`, e.g. `import { launch } from '@bugsee/bugsee/node'`.
import { readFileSync } from 'node:fs';
import { launch } from '@bugsee/bugsee/node';

const env = Object.fromEntries(
  readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const marker = `smoke-esm-umbrella-${Date.now()}`;
const client = launch(env.BUGSEE_APP_TOKEN, {
  endpoint: env.BUGSEE_ENDPOINT,
  appId: 'link-shortener',
  appVersion: '1.0.0',
  appBuild: 'smoke',
  capturedDataStore: 'memory',
  detectHangs: false,
  profiling: false,
});
client.launch();
console.log('isLaunched:', client.isLaunched());
await client.logException(new Error(`dual-module smoke: esm umbrella marker=${marker}`), {
  labels: ['scenario:dual-module', 'entry:esm-umbrella'],
});
await client.flush(8000);
await client.stop(3000);
console.log('SMOKE_OK esm-umbrella', marker);
