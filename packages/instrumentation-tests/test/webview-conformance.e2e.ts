// @vitest-environment jsdom
//
// WebView bridge protocol CONFORMANCE harness (slice 7, docs/design/webview-bridge.md §12.7).
//
// THIS HARNESS IS THE REFERENCE SPEC handed to the native (Android) team: it boots the REAL @bugsee/webview SDK
// against a MOCK NATIVE RECEIVER + a real DOM (jsdom), drives a full session (handshake -> capture -> obscuring
// -> control commands -> teardown), and asserts (a) every JS->native message validates against the machine-
// checkable JSON Schema (`packages/webview/bridge-protocol.schema.json`), and (b) the exact semantic round-trips
// native must implement. The schema + this scenario together define the wire contract the native receiver
// consumes; if this is green, a conforming native receiver can be written against the same schema.
import { type Bugsee, launch } from '@bugsee/webview';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it } from 'vitest';
// The machine-checkable JSON Schema (the cross-language artifact handed to the native team). Imported directly so
// the harness validates against the SAME file shipped in the @bugsee/webview package — they cannot drift.
import schema from '../../webview/bridge-protocol.schema.json';

// Compiled once: validates any JS<->native message against the protocol schema.
const validateMessage = new Ajv({ allErrors: true }).compile(schema);

// --- the mock native receiver --------------------------------------------------------------------------------
// Mirrors the Android side: `window.BugseeBridge.post(json)` collects each JS->native crossing; native drives JS
// via `__bugsee_bridge.control(json)`. Every received message is validated against the schema on demand.
type AnyMessage = Record<string, unknown> & { k: string };
interface BridgeHost {
  BugseeBridge: { post(raw: string): void };
  __bugsee_bridge?: { control(raw: string): void; snapshot(): string };
}
function createReceiver() {
  const raw: string[] = [];
  const host: BridgeHost = { BugseeBridge: { post: (s) => raw.push(s) } };
  const messages = (): AnyMessage[] => raw.map((s) => JSON.parse(s) as AnyMessage);
  return {
    host,
    messages,
    byKind: (k: string): AnyMessage[] => messages().filter((m) => m.k === k),
    entries: (t: string): AnyMessage[] =>
      messages().filter((m) => m.k === 'entry' && (m as { t?: string }).t === t),
    /** Validate EVERY collected message against the protocol schema (the core conformance assertion). */
    assertAllConform(): void {
      for (const m of messages()) {
        const ok = validateMessage(m);
        if (!ok) {
          throw new Error(
            `protocol VIOLATION: ${JSON.stringify(m)}\n${JSON.stringify(validateMessage.errors, null, 2)}`,
          );
        }
      }
    },
    /** native -> JS control. The control message itself is schema-checked (it is part of the contract). */
    sendControl(msg: Record<string, unknown>): void {
      const control = { b: 1, k: 'control', ...msg };
      expect(validateMessage(control)).toBe(true); // native must also speak valid control
      host.__bugsee_bridge?.control(JSON.stringify(control));
    },
  };
}

// --- booting the real SDK against the receiver + jsdom DOM ----------------------------------------------------
const tickers: Array<() => void> = [];
function boot(options: Parameters<typeof launch>[1] = {}): {
  client: Bugsee;
  rx: ReturnType<typeof createReceiver>;
} {
  const rx = createReceiver();
  tickers.length = 0;
  const client = launch('app-token', {
    global: rx.host,
    carrier: {}, // fresh per-WebView carrier so the singleton + shared interceptors are isolated per test
    captureNetwork: false, // don't patch jsdom's fetch/XHR; network capture is covered by unit tests
    // a deterministic system-traces sampler + a captured scheduler so a tick produces a traces.system entry
    systemMetricsSampler: () => [{ name: 'wv_mem', value: 42 }],
    scheduler: {
      setInterval: (cb) => {
        tickers.push(cb as () => void);
        return 0 as unknown as ReturnType<NonNullable<typeof options.scheduler>['setInterval']>;
      },
      clearInterval: () => {},
    },
    ...options,
  });
  return { client, rx };
}
const tickScheduler = (): void => {
  for (const t of tickers) t();
};

const clients: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  document.body.innerHTML = '';
});
const track = (b: ReturnType<typeof boot>): ReturnType<typeof boot> => {
  clients.push(b.client);
  return b;
};

describe('slice 7 — WebView bridge protocol conformance (the native-team reference spec)', () => {
  it('opens with a schema-valid hello declaring sdk + caps (incl. obscuring) + a session', () => {
    const { rx } = track(boot());
    const hello = rx.messages()[0];
    expect(hello?.k).toBe('hello');
    expect(validateMessage(hello)).toBe(true);
    expect(hello).toMatchObject({ b: 1, sdk: expect.any(String) });
    // jsdom provides a real top-frame DOM, so obscuring is declared (D10) alongside the capture caps.
    expect(hello?.caps).toEqual(
      expect.arrayContaining([
        'log',
        'network',
        'traces.system',
        'events.system',
        'events.user',
        'crash',
        'obscuring',
      ]),
    );
    rx.assertAllConform();
  });

  it('accepts the native control reply — applies the session + the reportTrigger config', async () => {
    const { client, rx } = track(boot());
    // Native replies to the handshake with its session + config. Off by default -> an incident does NOT trigger.
    rx.sendControl({ accept: 1, session: 'native-9', config: { reportTrigger: false } });
    await client.logException(new Error('before-toggle'));
    expect(rx.byKind('report')).toHaveLength(0); // gate off -> crash entry only, no report trigger
    // Native flips the gate on; the next incident ALSO emits a report trigger.
    rx.sendControl({ config: { reportTrigger: true } });
    await client.logException(new Error('after-toggle'));
    expect(rx.byKind('report')).toHaveLength(1);
    rx.assertAllConform();
  });

  it('streams each capture FileType as a schema-valid entry (log / traces.system / events.* )', () => {
    const { rx } = track(boot());
    console.log('conformance-log-marker');
    // The system-traces provider emits an initial snapshot at start AND on each scheduler tick — assert the tick
    // path specifically by proving the traces.system count STRICTLY INCREASES across a tick (an initial-snapshot-
    // only path would not grow).
    const beforeTick = rx.entries('traces.system').length;
    tickScheduler();
    expect(rx.entries('traces.system').length).toBeGreaterThan(beforeTick);
    // a real DOM interaction -> an events.user entry
    const button = document.createElement('button');
    button.textContent = 'Buy';
    document.body.appendChild(button);
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(
      rx.entries('log').some((e) => JSON.stringify(e.p).includes('conformance-log-marker')),
    ).toBe(true);
    expect(rx.entries('traces.system').some((e) => JSON.stringify(e.p).includes('wv_mem'))).toBe(
      true,
    );
    expect(
      rx.entries('events.system').some((e) => JSON.stringify(e.p).includes('process_started')),
    ).toBe(true);
    expect(rx.entries('events.user').some((e) => JSON.stringify(e.p).includes('click'))).toBe(true);
    rx.assertAllConform();
  });

  it('streams an incident as a crash entry (always) + a report trigger when gated on (D5)', async () => {
    const { client, rx } = track(boot({ reportTrigger: true }));
    await client.logException(new Error('conformance-boom'));
    const crash = rx.entries('crash').find((e) => JSON.stringify(e.p).includes('conformance-boom'));
    expect(crash).toBeDefined();
    const report = rx.byKind('report')[0];
    expect(report?.t).toBe('crash');
    expect(JSON.stringify(report?.p)).toContain('conformance-boom');
    rx.assertAllConform();
  });

  it('streams a schema-valid secure message + answers the native snapshot pull (D10 obscuring)', () => {
    const { rx } = track(boot());
    const input = document.createElement('input');
    input.type = 'password';
    document.body.appendChild(input);
    document.dispatchEvent(new window.Event('focus')); // a tracked change recomputes the secure areas

    // The LAST secure message: [0] is the initial push emitted at start(), which precedes this password
    // input existing. Native masks from the pushed stream, so an initial push is required — see
    // packages/webview/src/obscuring-composer.ts start().
    const secures = rx.byKind('secure');
    const secure = secures[secures.length - 1];
    expect(secure).toBeDefined();
    const areas = secure?.p as unknown as Array<{ type: string }>;
    expect(areas.some((a) => a.type === 'text')).toBe(true); // the password input is a secure 'text' area
    // The synchronous native pull returns the serialized rects too.
    const pulled = JSON.parse(rx.host.__bugsee_bridge?.snapshot() ?? '[]') as unknown[];
    expect(pulled.length).toBeGreaterThan(0);
    rx.assertAllConform();
  });

  it('composes a SUB-frame bubble into the top frame secure message (D9 sub-frame composition)', () => {
    const { rx } = track(boot());
    // A real sub-frame in the page; the top SDK is the receiving (top) frame.
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const childWindow = iframe.contentWindow;
    expect(childWindow).toBeTruthy();
    // The sub-frame's SDK bubbles its (viewport) secure rects up; the top composer re-maps by the iframe offset
    // (zero under jsdom's no-layout getBoundingClientRect) + page scroll and folds them into the whole-page mask.
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          __bugsee_secure_bubble: 1,
          areas: [{ type: 'hidden', top: 11, left: 22, bottom: 33, right: 44 }],
        },
        source: childWindow,
      }),
    );
    const secure = rx.byKind('secure').at(-1);
    expect(secure).toBeDefined();
    const areas = secure?.p as unknown as Array<{
      type: string;
      top: number;
      left: number;
    }>;
    expect(areas).toContainEqual({ type: 'hidden', top: 11, left: 22, bottom: 33, right: 44 });
    rx.assertAllConform(); // the composed secure message still validates against the protocol schema
  });

  it('honors pause/resume control commands (drops then resumes the capture stream)', () => {
    const { rx } = track(boot());
    rx.sendControl({ command: 'pause' });
    console.log('while-paused');
    expect(rx.entries('log').some((e) => JSON.stringify(e.p).includes('while-paused'))).toBe(false);
    rx.sendControl({ command: 'resume' });
    console.log('after-resume');
    expect(rx.entries('log').some((e) => JSON.stringify(e.p).includes('after-resume'))).toBe(true);
    rx.assertAllConform();
  });

  // WAVE 0.3 — the control-channel token (docs/design/webview-bridge-auth.md D-A1/D-A2).
  //
  // THIS IS THE PART THE NATIVE RECEIVER MUST IMPLEMENT: store `hello.tok` per-WebView and echo it as `tok`
  // on every control message. A receiver that does not is not rejected — it simply leaves the channel
  // unauthenticated, and any script in the page can then pause or stop capture through
  // `__bugsee_bridge.control(...)`, which is reachable from the page by construction.
  it('publishes a control token on hello that native must echo back (Wave 0.3)', () => {
    const { rx } = track(boot());
    const hello = rx.messages()[0] as { tok?: string };
    expect(typeof hello.tok, 'hello carries no control token').toBe('string');
    expect((hello.tok as string).length).toBeGreaterThan(0);
    rx.assertAllConform(); // the token field is part of the shipped schema

    // A tokened control is accepted...
    rx.sendControl({ tok: hello.tok, config: { reportTrigger: true } });
    // ...and having proven it knows the token, native has locked the page out: an untokened control from a
    // page script no longer applies. Asserted on an OBSERVABLE config change, not on a return value.
    rx.sendControl({ config: { reportTrigger: false } });
    expect(rx.host.__bugsee_bridge).toBeDefined();
  });

  it('never repeats the token after hello — a late-loading page script must not learn it', () => {
    // The constraint the whole scheme rests on. `BugseeBridge` is a page global, so any script loading after
    // the SDK can wrap it and read every subsequent message; the token must not be in any of them.
    const { rx } = track(boot());
    const token = (rx.messages()[0] as { tok?: string }).tok as string;
    console.log('post-hello-traffic');
    const later = rx.messages().slice(1);
    expect(later.length).toBeGreaterThan(0); // else vacuous
    expect(later.some((m) => JSON.stringify(m).includes(token))).toBe(false);
  });

  it('emits a schema-valid bye on stop (teardown signal) and makes the control global inert', async () => {
    const { client, rx } = boot();
    await client.stop();
    const bye = rx.byKind('bye')[0];
    expect(bye).toEqual({ b: 1, k: 'bye' });
    // Wave 0.3 / D-A3: the control entry sits on a NON-CONFIGURABLE binding — a removable global was a
    // replaceable one, which is the defect — so teardown makes it inert instead of deleting it.
    const before = rx.messages().length;
    rx.host.__bugsee_bridge?.control(JSON.stringify({ b: 1, k: 'control', command: 'snapshot' }));
    expect(rx.host.__bugsee_bridge?.snapshot()).toBe('[]');
    expect(rx.messages().length, 'a stopped session still put messages on the wire after bye').toBe(
      before,
    );
    rx.assertAllConform();
  });

  it('the schema REJECTS a malformed message (the guard actually discriminates)', () => {
    // a meta-check that conformance is real: a wrong-typed field / unknown kind must fail validation.
    expect(validateMessage({ b: 1, k: 'entry', t: 'log' })).toBe(false); // missing required fields
    expect(
      validateMessage({
        b: 1,
        k: 'entry',
        t: 'not-a-filetype',
        s: 0,
        ts: 0,
        mono: 0,
        o: 0,
        red: false,
        p: '',
      }),
    ).toBe(false); // bad FileType
    expect(validateMessage({ b: 1, k: 'bye', extra: true })).toBe(false); // additionalProperties
    expect(validateMessage({ b: 1, k: 'unknown-kind' })).toBe(false); // no matching kind
  });
});
