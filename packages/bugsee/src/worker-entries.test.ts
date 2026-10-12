import type { HttpTransport } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import { launch as launchEdgeLight } from './index.edge-light';
import { launch as launchWorker } from './index.worker';
import { launch as launchWorkerd } from './index.workerd';

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
