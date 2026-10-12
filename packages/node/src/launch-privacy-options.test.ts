import { createMemoryCaptureStore, type HttpTransport } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemProbe } from './environment';

// The node options that were read RAW (`!== false`, `=== undefined || === false`): `0`, `null`, `''`,
// `'false'` turned local-variable capture and source-context capture ON, and `'false'` left incoming-request
// instrumentation ON. Now every one goes through the shared normaliser:
//   captureLocalVariables / captureSourceContext (collect MORE data): only `true` or an options object turns
//     them on; anything else is OFF + onError;
// instrumentIncomingRequests (default ON, collects request data): an invalid value is OFF + onError;
//   `false` opts out, `true`/absent installs.

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  session: vi.fn(),
  enricher: vi.fn(),
}));

vi.mock('./local-variables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./local-variables')>();
  return {
    ...actual,
    createInspectorSession: (...args: unknown[]) => {
      mocks.session(...args);
      return { connect() {}, disconnect() {}, post() {}, on() {} };
    },
    createLocalVariablesCapture: (...args: unknown[]) => {
      mocks.capture(...args);
      return { lookup: () => undefined, dispose() {} };
    },
  };
});
vi.mock('./source-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source-context')>();
  return {
    ...actual,
    createSourceContextEnricher: (...args: unknown[]) => {
      mocks.enricher(...args);
      return (frames: unknown) => frames;
    },
  };
});

const { launch } = await import('./launch');
type Options = Parameters<typeof launch>[1];

const probe: SystemProbe = {
  platformType: () => 'node',
  runtimeVersion: () => '20.1.2',
  osType: () => 'Linux',
  osPlatform: () => 'darwin',
  osRelease: () => '6.0',
  osArch: () => 'arm64',
  machine: () => 'x86_64',
  cpuCount: () => 8,
  totalMemory: () => 16_000,
  freeMemory: () => 4_000,
  utcOffsetMinutes: () => 0,
  locale: () => 'en-US',
};

const fakeProcess = () => {
  const proc = {
    on: () => proc,
    off: () => proc,
    listeners: () => [],
    stderr: { write: () => true },
    exit: () => {},
    kill: () => {},
    pid: process.pid,
  };
  return proc;
};

const clients: Array<ReturnType<typeof launch>> = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  vi.clearAllMocks();
});

const start = (over: Record<string, unknown>) => {
  const onError = vi.fn();
  const client = launch('tok', {
    process: fakeProcess(),
    transport: vi.fn<HttpTransport>(async () => ({
      status: 200,
      headers: {},
      body: new Uint8Array(),
    })),
    systemProbe: probe,
    systemMetricsSampler: () => [],
    captureNetwork: false,
    detectHangs: false,
    carrier: {},
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    onError,
    ...over,
  } as Options);
  clients.push(client);
  return { client, onError };
};
const reportsFor = (onError: ReturnType<typeof vi.fn>, name: string) =>
  onError.mock.calls.filter((c) => String((c[0] as Error).message).startsWith(`${name} must be`));

const INVALID: unknown[] = [null, 0, '', 'false', 'true', 1, []];

describe('captureLocalVariables / captureSourceContext: invalid => OFF + onError (R3V-3)', () => {
  it.each(
    INVALID,
  )('captureLocalVariables=%j builds no capture and never touches the inspector', (bad) => {
    const { client, onError } = start({ captureLocalVariables: bad });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
    expect(reportsFor(onError, 'captureLocalVariables')).toHaveLength(1);
    expect(client.isLaunched()).toBe(true);
  });

  it.each(INVALID)('captureSourceContext=%j builds no enricher', (bad) => {
    const { onError } = start({ captureSourceContext: bad });
    expect(mocks.enricher).not.toHaveBeenCalled();
    expect(reportsFor(onError, 'captureSourceContext')).toHaveLength(1);
  });

  it('true turns both on, silently', () => {
    const on = start({ captureLocalVariables: true, captureSourceContext: true });
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.session).toHaveBeenCalledTimes(1);
    expect(mocks.enricher).toHaveBeenCalledTimes(1);
    expect(on.onError).not.toHaveBeenCalled();
  });

  it('an option bag is passed through to the capture (and its own session wins)', () => {
    const session = { connect() {}, disconnect() {}, post() {}, on() {} };
    const { onError } = start({
      captureLocalVariables: { session, includeCaught: true },
      captureSourceContext: { contextLines: 3 },
    });
    expect(mocks.capture.mock.calls[0]?.[0]).toMatchObject({ session, includeCaught: true });
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.enricher.mock.calls[0]?.[0]).toMatchObject({ contextLines: 3 });
    expect(onError).not.toHaveBeenCalled();
  });

  it('false / absent: nothing built, nothing reported', () => {
    const off = start({ captureLocalVariables: false, captureSourceContext: false });
    expect(off.onError).not.toHaveBeenCalled();
    const absent = start({});
    expect(absent.onError).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.enricher).not.toHaveBeenCalled();
  });

  it('records the EFFECTIVE value (never the bag) in the launch options', () => {
    const { client } = start({
      captureLocalVariables: { includeCaught: true },
      captureSourceContext: 0,
    });
    const effective = client.getLaunchOptions();
    expect(effective['com.bugsee.option.capture.local-variables']).toBe(true);
    expect(effective['com.bugsee.option.capture.source-context']).toBe(false);
  });
});

describe('instrumentIncomingRequests: only boolean false opts out (R3V-3)', () => {
  const installable = () => ({ install: vi.fn(), uninstall: vi.fn() });

  it.each(
    INVALID,
  )('instrumentIncomingRequests=%j is OFF (fail closed, R4V-2) and reports', (bad) => {
    const server = installable();
    const { onError } = start({ instrumentIncomingRequests: bad, serverInterceptor: server });
    expect(server.install).not.toHaveBeenCalled();
    expect(reportsFor(onError, 'instrumentIncomingRequests')).toHaveLength(1);
  });

  it('false opts out silently; true installs silently', () => {
    const off = installable();
    const a = start({ instrumentIncomingRequests: false, serverInterceptor: off });
    expect(off.install).not.toHaveBeenCalled();
    expect(a.onError).not.toHaveBeenCalled();
    const on = installable();
    const b = start({ instrumentIncomingRequests: true, serverInterceptor: on });
    expect(on.install).toHaveBeenCalledTimes(1);
    expect(b.onError).not.toHaveBeenCalled();
  });
});
