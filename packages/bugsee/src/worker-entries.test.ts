import type { HttpTransport } from '@bugsee/core';
import { BugseeStatus } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import * as edgeLightEntry from './index.edge-light';
import * as workerEntry from './index.worker';
import * as workerdEntry from './index.workerd';

const launchEdgeLight = edgeLightEntry.launch;
const launchWorker = workerEntry.launch;
const launchWorkerd = workerdEntry.launch;

// The umbrella's worker / edge entries are thin re-exports of the incident-driven platform SDKs, which wire
// no performance extension. They must still expose the top-level `startTransaction` / `startSpan` /
// `getActiveSpan` (mobile parity), as harmless no-ops. Only the runtime that resolves a given entry ever
// loads it, so these run each entry's `launch` directly under Node.

const transport: HttpTransport = async () => ({ status: 200, headers: {}, body: new Uint8Array() });
const scope = { addEventListener: () => {}, removeEventListener: () => {} };

type Launched = {
  stop(): Promise<boolean>;
  startTransaction(name: string, operation: string): { isSampled(): boolean; getName(): string };
  startSpan(operation: string, description?: string): { getOperation(): string };
  getActiveSpan(): unknown;
};
const launched: Launched[] = [];
const track = (c: Launched): Launched => {
  launched.push(c);
  return c;
};
afterEach(async () => {
  await Promise.all(launched.splice(0).map((c) => c.stop()));
});

describe.each([
  [
    'worker',
    () =>
      launchWorker('tok', { carrier: {}, transport, captureNetwork: false, globalScope: scope }),
  ],
  ['edge-light', () => launchEdgeLight('tok', { carrier: {}, transport, captureNetwork: false })],
  ['workerd', () => launchWorkerd('tok', { carrier: {}, transport, captureNetwork: false })],
])('%s entry launch()', (_name, start) => {
  it('returns a client whose performance calls are no-ops', () => {
    const client = track(start() as unknown as Launched);
    const txn = client.startTransaction('Checkout', 'ui.load');
    expect(txn.getName()).toBe('Checkout');
    expect(txn.isSampled()).toBe(false);
    expect(client.startSpan('db.query', 'select').getOperation()).toBe('db.query');
    expect(client.getActiveSpan()).toBeUndefined();
  });
});

// getStatus / relaunch on the worker and edge entries: relaunch re-runs THIS entry's launch,
// stopping the old client first, and the status follows the process state.
describe.each([
  [
    'worker',
    workerEntry,
    (carrier: object) => ({ carrier, transport, captureNetwork: false, globalScope: scope }),
  ],
  [
    'edge-light',
    edgeLightEntry,
    (carrier: object) => ({ carrier, transport, captureNetwork: false }),
  ],
  ['workerd', workerdEntry, (carrier: object) => ({ carrier, transport, captureNetwork: false })],
] as const)('%s entry lifecycle', (_name, entry, makeOptions) => {
  it('getStatus follows the process state and relaunch returns a fresh client of this entry', async () => {
    const carrier = {};
    const options = makeOptions(carrier);
    expect(entry.getStatus(carrier)).toBe(BugseeStatus.Stopped);
    const first = track(entry.launch('tok', options as never) as unknown as Launched);
    expect(entry.getStatus(carrier)).toBe(BugseeStatus.Launched);
    const second = track((await entry.relaunch(options as never)) as unknown as Launched);
    expect(second).not.toBe(first);
    expect((first as unknown as { getStatus(): BugseeStatus }).getStatus()).toBe(
      BugseeStatus.Stopped,
    );
    expect(entry.getStatus(carrier)).toBe(BugseeStatus.Launched);
    expect(second.startTransaction('x', 'y').isSampled()).toBe(false); // the entry's own facade is wired
  });

  it('relaunch before any launch rejects (nothing to reuse)', async () => {
    await expect(entry.relaunch(makeOptions({}) as never)).rejects.toThrow(/before launch/);
  });
});
