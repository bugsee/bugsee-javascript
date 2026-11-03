// A batch of nine REAL platform APIs that reject asynchronously, each started from a named application function (non-tail: see the React
// scenario), with the rejection handed to `logException`. Each case records whether the engine's reason has a stack of its own; the
// test asserts the report found the call site for exactly those that do not. Armed rows (image.decode, FontFace.load, ...) only start
// recording after the first stackless, unlocated rejection reaches the SDK, so one such rejection is left unhandled first.
// Run by `test/async-origin.apis.browser.e2e.ts`.
import { launch } from '@bugsee/browser';

interface CaseResult {
  name: string;
  mode: 'always' | 'armed';
  settled: 'rejected' | 'resolved' | 'threw' | 'unsupported';
  reasonName?: string;
  hasOwnStack?: boolean;
}
interface E2EWindow extends Window {
  __E2E__: {
    state: 'running' | 'done' | 'failed';
    error?: string;
    sdkErrors: string[];
    cases?: CaseResult[];
  };
  __E2E_COLLECTOR__?: string;
}
const w = window as unknown as E2EWindow;
const bridge: E2EWindow['__E2E__'] = { state: 'running', sdkErrors: [] };
w.__E2E__ = bridge;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const BROKEN_IMAGE = '/broken.png'; // the page server answers an unknown path with an HTML page: not decodable as an image
const a = (promise: Promise<unknown>): Promise<unknown> => {
  const started = promise; // non-tail: keep the calling function's frame on WebKit
  return started;
};

// ---- the application functions that call the APIs (their names are what the report must contain) ----
const startDecodeAudioData = (): Promise<unknown> =>
  a(new AudioContext().decodeAudioData(new ArrayBuffer(16)));
const startClipboardRead = (): Promise<unknown> => a(navigator.clipboard.readText());
const startGetUserMedia = (): Promise<unknown> =>
  a(navigator.mediaDevices.getUserMedia({ video: true, audio: true }));
const startServiceWorkerRegister = (): Promise<unknown> =>
  a(navigator.serviceWorker.register('/missing-sw.js'));
const startAudioWorkletAddModule = (): Promise<unknown> =>
  a(new AudioContext().audioWorklet.addModule('/missing-worklet.js'));
const startPermissionsQuery = (): Promise<unknown> =>
  a(navigator.permissions.query({ name: 'bogus' as PermissionName }));
const startImageDecode = (): Promise<unknown> => {
  const image = new Image();
  image.src = BROKEN_IMAGE;
  return a(image.decode());
};
const startFontLoad = (): Promise<unknown> =>
  a(new FontFace('e2e-font', 'url(/missing.woff2)').load());
const startCreateImageBitmap = (): Promise<unknown> =>
  a(createImageBitmap(new Blob(['not an image'], { type: 'image/png' })));

const CASES: { name: string; mode: CaseResult['mode']; start: () => Promise<unknown> }[] = [
  { name: 'startDecodeAudioData', mode: 'always', start: startDecodeAudioData },
  { name: 'startClipboardRead', mode: 'always', start: startClipboardRead },
  { name: 'startGetUserMedia', mode: 'always', start: startGetUserMedia },
  { name: 'startServiceWorkerRegister', mode: 'always', start: startServiceWorkerRegister },
  { name: 'startAudioWorkletAddModule', mode: 'always', start: startAudioWorkletAddModule },
  { name: 'startPermissionsQuery', mode: 'always', start: startPermissionsQuery },
  { name: 'startImageDecode', mode: 'armed', start: startImageDecode },
  { name: 'startFontLoad', mode: 'armed', start: startFontLoad },
  { name: 'startCreateImageBitmap', mode: 'armed', start: startCreateImageBitmap },
];

async function main(): Promise<void> {
  const endpoint = w.__E2E_COLLECTOR__;
  if (endpoint === undefined || endpoint === '') {
    throw new Error('__E2E_COLLECTOR__ is not set');
  }
  const client = await launch('e2e-app-token', {
    endpoint,
    appVersion: '1.0.0',
    appBuild: '1',
    persist: false,
    recover: false,
    onError: (e: unknown) => bridge.sdkErrors.push(String(e)),
  });

  // Arm the armed rows: a stackless rejection nobody could locate (an armed API is not wrapped yet), left unhandled.
  void startImageDecode();
  await sleep(600);

  const results: CaseResult[] = [];
  for (const entry of CASES) {
    const result: CaseResult = { name: entry.name, mode: entry.mode, settled: 'unsupported' };
    try {
      const outcome = await Promise.race([
        entry.start().then(
          () => ({ kind: 'resolved' as const }),
          (reason: unknown) => ({ kind: 'rejected' as const, reason }),
        ),
        sleep(4000).then(() => ({ kind: 'timeout' as const })),
      ]);
      if (outcome.kind === 'rejected') {
        const reason = outcome.reason as { name?: string; stack?: unknown };
        result.settled = 'rejected';
        result.reasonName = reason?.name;
        result.hasOwnStack = typeof reason?.stack === 'string' && reason.stack !== '';
        await client.logException(outcome.reason, { labels: [`case:${entry.name}`] } as never);
      } else if (outcome.kind === 'resolved') {
        result.settled = 'resolved';
      }
    } catch (error) {
      result.settled = typeof error === 'object' && error !== null ? 'threw' : 'unsupported';
    }
    results.push(result);
  }
  bridge.cases = results;
  await sleep(300);
  await client.flush();
}

main().then(
  () => {
    bridge.state = 'done';
  },
  (err: unknown) => {
    bridge.error = String(err);
    bridge.state = 'failed';
  },
);
