// A dedicated Web Worker that does real work (price/discount computation for the cart) AND runs its
// own Bugsee session via @bugsee/webworker — a SEPARATE session from the main-thread one (workers get
// their own environment.platform.type = 'web-worker'). Exercises: worker launch, console→log capture,
// fetch capture from inside a worker, an uncaught throw, and a postMessage round trip that must survive
// capture (interceptors must not alter app behaviour).
import { launch } from '@bugsee/webworker';

const token = import.meta.env.BUGSEE_APP_TOKEN;
// See server/bugsee-proxy.ts + FINDINGS.md F-2 (blocker): apidev.bugsee.com's CORS config rejects
// every third-party origin, so every session in this sample — including the worker's own — goes
// through the same-origin reverse proxy instead of the raw BUGSEE_ENDPOINT.
const endpoint = `${self.location.origin}/bugsee-proxy`;

const client =
  token !== undefined && token.length > 0
    ? launch(token, {
        endpoint,
        // See FINDINGS.md F-3: the packed SDK version (0.0.0) is below the backend's accepted floor.
        sdkVersion: '1.0.0',
        appVersion: '1.0.0',
        appBuild: '7',
        onError: (error) => {
          // eslint-disable-next-line no-console
          console.warn('[price-worker bugsee onError]', error);
        },
      })
    : undefined;

client?.setAttribute('sample', 'browser-vanilla:price-worker');

interface ComputeRequest {
  type: 'compute';
  id: number;
  prices: number[];
  discountPct: number;
}
interface ThrowRequest {
  type: 'throw';
}
interface LogRequest {
  type: 'log';
  message: string;
}
type WorkerRequest = ComputeRequest | ThrowRequest | LogRequest;

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const data = event.data;
  if (data.type === 'compute') {
    console.info(`[price-worker] computing discount for ${data.prices.length} line(s)`);
    // A real (if simple) computation: apply the discount, round to cents, sum a total.
    const discounted = data.prices.map((p) => Math.round(p * (1 - data.discountPct / 100) * 100) / 100);
    const total = Math.round(discounted.reduce((a, b) => a + b, 0) * 100) / 100;
    (self as unknown as Worker).postMessage({ type: 'result', id: data.id, discounted, total });
    return;
  }
  if (data.type === 'log') {
    console.log(data.message);
    return;
  }
  if (data.type === 'throw') {
    // Deliberate uncaught throw inside the worker — S5 crash detection, worker session.
    throw new Error('price-worker: deliberate uncaught exception (scenario panel)');
  }
});

export {};
