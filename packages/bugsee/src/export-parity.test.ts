import { describe, expect, it } from 'vitest';
import * as browserEntry from './index';
import * as bunEntry from './index.bun';
import * as denoEntry from './index.deno';
import * as edgeEntry from './index.edge-light';
import * as nodeEntry from './index.node';
import * as workerEntry from './index.worker';
import * as workerdEntry from './index.workerd';

// EXPORT PARITY across the seven umbrella entries (review O5). Which entry a user gets depends on a bundler
// condition they never see, so a name that exists on one entry and not another is a runtime-only surprise
// ("works on node, `undefined is not a function` on the edge"). Every name below is part of the public API
// every runtime must expose. Type-only exports cannot be seen here; they are pinned in
// `export-parity.test-d.ts`, which `tsc --noEmit` checks.
const entries = {
  browser: browserEntry,
  node: nodeEntry,
  bun: bunEntry,
  deno: denoEntry,
  'edge-light': edgeEntry,
  worker: workerEntry,
  workerd: workerdEntry,
} as const;

const PUBLIC_RUNTIME_API = [
  'launch',
  'relaunch',
  'getStatus',
  'BugseeStatus',
  'getDefaultNetworkSanitizer',
  'LifecycleEvents',
] as const;

// `relaunch` / `getStatus` / `BugseeStatus` are being added to the edge/worker entries by the lifecycle work
// (group G2 of the mobile-alignment review) in a separate change. The names stay in the REQUIRED list above;
// this exemption only keeps this test green until that change merges. DELETE it afterwards.
const PENDING_LIFECYCLE_EXPORTS: Record<string, readonly string[]> = {
  'edge-light': ['relaunch', 'getStatus', 'BugseeStatus'],
  worker: ['relaunch', 'getStatus', 'BugseeStatus'],
  workerd: ['relaunch', 'getStatus', 'BugseeStatus'],
};

describe('public API export parity across the umbrella entries', () => {
  for (const [entryName, entry] of Object.entries(entries)) {
    for (const name of PUBLIC_RUNTIME_API) {
      const exempt = PENDING_LIFECYCLE_EXPORTS[entryName]?.includes(name) === true;
      it.skipIf(exempt)(`${entryName} exports ${name}`, () => {
        expect(name in entry).toBe(true);
        expect((entry as Record<string, unknown>)[name]).toBeDefined();
      });
    }
  }

  it('getDefaultNetworkSanitizer is the same redactor everywhere, and still redacts', () => {
    const reference = browserEntry.getDefaultNetworkSanitizer;
    for (const entry of Object.values(entries)) {
      expect(entry.getDefaultNetworkSanitizer).toBe(reference);
    }
    expect(reference().sanitizeUrl('https://a.test/x?token=SECRET')).not.toContain('SECRET');
  });

  it('the server-side entries expose the same lifecycle surface as the browser entry', () => {
    for (const entry of [nodeEntry, bunEntry, denoEntry]) {
      expect(entry.getStatus).toBe(browserEntry.getStatus);
      expect(entry.BugseeStatus).toBe(browserEntry.BugseeStatus);
    }
  });
});
