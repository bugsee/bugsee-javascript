import { LifecycleEvents } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import * as browserEntry from './index';
import * as bunEntry from './index.bun';
import * as denoEntry from './index.deno';
import * as edgeEntry from './index.edge-light';
import * as nodeEntry from './index.node';
import * as workerEntry from './index.worker';
import * as workerdEntry from './index.workerd';

// Every umbrella entry re-exports the lifecycle constants (the same object as core's), so
// `setLifecycleEventsListener` is usable on every runtime without reaching into @bugsee/core.
describe('LifecycleEvents is re-exported from every umbrella entry', () => {
  const entries = {
    browser: browserEntry,
    node: nodeEntry,
    bun: bunEntry,
    deno: denoEntry,
    'edge-light': edgeEntry,
    worker: workerEntry,
    workerd: workerdEntry,
  };
  for (const [name, entry] of Object.entries(entries)) {
    it(name, () => {
      expect(entry.LifecycleEvents).toBe(LifecycleEvents);
    });
  }
});
