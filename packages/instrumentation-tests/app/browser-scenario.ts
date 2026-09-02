// The battery the browser harness runs inside a REAL Chromium page (`test/browser.e2e.ts` bundles this
// file with esbuild and serves it). The node/bun/deno entries spawn a real process; this is the same idea
// for the web tier — the real `@bugsee/browser` launch, a real DOM, a real rrweb recorder, real
// `window.onerror`, real `fetch`, and (in the `persist` scenario) real IndexedDB.
//
// Why it exists: every browser-tier suite up to now ran under jsdom, which is a DOM implementation but not
// a browser engine. It has no layout, no real event dispatch from user input, and a shimmed IndexedDB —
// so the three things most likely to break in a browser were the three things never exercised in one.
// `replay.e2e.ts` says as much in its own header, calling a Playwright run the documented follow-up.
//
// The page drives this through `window.__E2E__`: the harness sets `__E2E_COLLECTOR__` (and optionally
// `__E2E_SCENARIO__`) before the bundle loads, and polls `window.__E2E__.state` afterwards.
import { launch } from '@bugsee/browser';
import { BROWSER_BODY_TEXT, BROWSER_SECRET, BROWSER_VISIBLE_TEXT } from './browser-constants';

interface E2EBridge {
  /** `running` → `done`, or `failed` with `error` set. Polled by the harness. */
  state: 'running' | 'done' | 'failed';
  error?: string;
  /** Anything the SDK reported through `onError`, so a silent internal failure is still visible. */
  sdkErrors: string[];
}

interface E2EWindow extends Window {
  __E2E__: E2EBridge;
  __E2E_COLLECTOR__?: string;
  __E2E_SCENARIO__?: string;
}

const w = window as unknown as E2EWindow;

const bridge: E2EBridge = { state: 'running', sdkErrors: [] };
w.__E2E__ = bridge;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Build the page's DOM: a masked heading, an ordinary input, and a password input. */
function buildPage(): { text: HTMLInputElement; password: HTMLInputElement } {
  const heading = document.createElement('h1');
  heading.textContent = BROWSER_BODY_TEXT;
  document.body.appendChild(heading);

  const text = document.createElement('input');
  text.type = 'text';
  text.name = 'nickname';
  text.id = 'e2e-text';
  document.body.appendChild(text);

  const password = document.createElement('input');
  password.type = 'password';
  password.name = 'password';
  password.id = 'e2e-password';
  document.body.appendChild(password);

  return { text, password };
}

/**
 * The main battery: console output, a real outgoing fetch, a real user-typed password (which must be
 * masked), a logged exception, and a REAL uncaught error routed through `window.onerror`.
 */
async function runMain(collectorUrl: string): Promise<void> {
  const client = launch('e2e-app-token', {
    endpoint: collectorUrl,
    appVersion: '1.2.3',
    appBuild: '42',
    replay: true,
    captureInteractions: true,
    // Memory-only: this scenario is about capture fidelity, and the durable path has its own scenario
    // below where real IndexedDB is the point rather than an uncontrolled variable.
    persist: false,
    recover: false,
    onError: (e: unknown) => bridge.sdkErrors.push(String(e)),
  });

  const fields = buildPage();

  console.log('e2e browser log line: hello from the instrumented page');
  console.error('e2e browser error log line: something noteworthy');

  // A real outgoing request the browser network interceptor captures.
  const res = await fetch(`${collectorUrl}/echo?probe=browser`);
  await res.text();

  // Real typing, dispatched as real events, into an ordinary field and a password field. rrweb records
  // both; only the password's characters must be absent from the bundle.
  type_(fields.text, BROWSER_VISIBLE_TEXT);
  type_(fields.password, BROWSER_SECRET);
  fields.password.blur();

  // Let the recorder observe the mutations before anything drains the capture window.
  await sleep(150);

  // A logged exception → an error report bundle carrying the capture window above.
  await client.logException(new Error('e2e browser handled failure'));

  // A REAL uncaught error: thrown from a timer so it reaches `window.onerror` the way a production bug
  // does, rather than being caught by this function's own await chain.
  setTimeout(() => {
    throw new Error('e2e browser uncaught failure');
  }, 0);

  // The uncaught report is assembled asynchronously off the error event; give it a window to be
  // submitted, then flush so the harness is not racing the upload.
  await sleep(400);
  await client.flush();
}

/** Set a field's value the way a user does, so rrweb sees real `input` events rather than a silent poke. */
function type_(field: HTMLInputElement, value: string): void {
  field.focus();
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * The durable-storage battery: `persist` + `recover` against a REAL IndexedDB. Every existing browser
 * persistence test runs on `fake-indexeddb`, so this is the first time the SDK's own IDB code meets the
 * engine's — including the transaction-commit durability semantics the round-7 fix depends on.
 */
async function runPersist(collectorUrl: string): Promise<void> {
  const client = launch('e2e-app-token', {
    endpoint: collectorUrl,
    appVersion: '1.2.3',
    appBuild: '42',
    persist: true,
    recover: true,
    replay: false,
    onError: (e: unknown) => bridge.sdkErrors.push(String(e)),
  });

  console.log('e2e persisted log line');
  await client.logException(new Error('e2e browser persisted failure'));
  await client.flush();
}

async function main(): Promise<void> {
  const collectorUrl = w.__E2E_COLLECTOR__;
  if (collectorUrl === undefined || collectorUrl === '') {
    throw new Error('__E2E_COLLECTOR__ is not set');
  }
  const scenario = w.__E2E_SCENARIO__ ?? 'main';
  if (scenario === 'persist') {
    await runPersist(collectorUrl);
    return;
  }
  await runMain(collectorUrl);
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
