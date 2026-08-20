// Reproduction script for FINDINGS.md F-1 (blocker): staging (apidev.bugsee.com) rejects EVERY
// session-creation call for this app token, so no report from this sample can ever reach the backend.
//
// Usage: node --env-file=.env scripts/repro-session-rejected.mjs [sdkVersion]
//
//   node --env-file=.env scripts/repro-session-rejected.mjs        # default sdkVersion (package version, "0.0.0")
//   node --env-file=.env scripts/repro-session-rejected.mjs 1.0.0  # a plausible real version
//
// Wraps the REAL @bugsee/node-utils httpRequest transport (the exact one the SDK uses in production)
// to print the request/response of the SDK's own control-plane call. No sample code, no HTTP server —
// just launch() + logException() against the real @bugsee/bugsee/node entry.
import { readFileSync } from 'node:fs';
import { launch } from '@bugsee/bugsee/node';
import { httpRequest } from '@bugsee/node-utils';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const loggingTransport = async (url, options) => {
  const res = await httpRequest(url, options);
  if (url.includes('/v2/sessions')) {
    console.log('>>> POST /v2/sessions body:', options.body);
    console.log('<<< status', res.status, 'body:', Buffer.from(res.body).toString('utf8'));
  }
  return res;
};

const sdkVersion = process.argv[2]; // undefined -> the SDK's own default (the package version, 0.0.0)
console.log(`Testing with sdkVersion=${sdkVersion ?? '(default, package version)'} against ${env.BUGSEE_ENDPOINT}`);

const client = launch(env.BUGSEE_APP_TOKEN, {
  endpoint: env.BUGSEE_ENDPOINT,
  appId: 'link-shortener',
  appVersion: '1.0.0',
  appBuild: 'repro',
  capturedDataStore: 'memory',
  detectHangs: false,
  profiling: false,
  transport: loggingTransport,
  ...(sdkVersion !== undefined ? { sdkVersion } : {}),
});
client.launch();
const result = await client.logException(new Error('F-1 repro'));
console.log('\nFinal client-visible result:', result);
console.log('result.error?.message:', result.error?.message, '(note: the real backend error above is swallowed — see F-3)');
await client.stop(3000);
process.exit(0);
