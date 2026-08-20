// Dual-module smoke test 4/4: CJS require() of the DIRECT `@bugsee/node` package.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { launch } = require('@bugsee/node');

const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

(async () => {
  const marker = `smoke-cjs-direct-${Date.now()}`;
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
  await client.logException(new Error(`dual-module smoke: cjs direct @bugsee/node marker=${marker}`), {
    labels: ['scenario:dual-module', 'entry:cjs-direct'],
  });
  await client.flush(8000);
  await client.stop(3000);
  console.log('SMOKE_OK cjs-direct', marker);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
