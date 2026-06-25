import type { Client, ReportingRequest } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createEdgeUnhandledRejectionProvider, type EdgeGlobalEvents } from './detection';

// A fake global event target: records listeners by type + dispatches synthetic events.
function fakeTarget() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const target: EdgeGlobalEvents = {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    target,
    emit: (type: string, event: unknown) => {
      for (const l of listeners.get(type) ?? []) l(event);
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

const start = (provider: ReturnType<typeof createEdgeUnhandledRejectionProvider>) => {
  const requests: ReportingRequest[] = [];
  provider.start({} as Client, (r) => requests.push(r));
  return requests;
};

describe('createEdgeUnhandledRejectionProvider', () => {
  it('has the stable provider name + default target (globalThis)', () => {
    expect(createEdgeUnhandledRejectionProvider().name).toBe('edge-unhandled-rejection');
  });

  it('registers on the global unhandledrejection event + removes on stop', () => {
    const t = fakeTarget();
    const provider = createEdgeUnhandledRejectionProvider(t.target);
    provider.start({} as Client, () => {});
    expect(t.count('unhandledrejection')).toBe(1);
    provider.stop();
    expect(t.count('unhandledrejection')).toBe(0);
  });

  it('reports an error (mechanism unhandledrejection) with summary + V8-parsed stack from the reason', () => {
    const t = fakeTarget();
    const requests = start(createEdgeUnhandledRejectionProvider(t.target));
    const err = new Error('rejected');
    err.stack = 'Error: rejected\n    at handler (worker.js:5:9)'; // V8 dialect
    t.emit('unhandledrejection', { reason: err });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.source).toEqual({ type: 'error', mechanism: 'unhandledrejection' });
    expect(requests[0]?.report.type).toBe('error');
    expect(requests[0]?.report.summary).toBe('rejected');
    expect(requests[0]?.report.description).toContain('worker.js:5:9');
  });

  it('uses the error NAME when the message is empty', () => {
    const t = fakeTarget();
    const requests = start(createEdgeUnhandledRejectionProvider(t.target));
    const err = new TypeError(''); // empty message → fall back to the name
    t.emit('unhandledrejection', { reason: err });
    expect(requests[0]?.report.summary).toBe('TypeError');
  });

  it('omits the description when the Error has no stack', () => {
    const t = fakeTarget();
    const requests = start(createEdgeUnhandledRejectionProvider(t.target));
    const err = new Error('nostack');
    delete (err as { stack?: string }).stack;
    t.emit('unhandledrejection', { reason: err });
    expect(requests[0]?.report.summary).toBe('nostack');
    expect(requests[0]?.report.description).toBeUndefined();
  });

  it('reports a non-Error rejection via String(value), no description', () => {
    const t = fakeTarget();
    const requests = start(createEdgeUnhandledRejectionProvider(t.target));
    t.emit('unhandledrejection', { reason: 'boom-string' });
    expect(requests[0]?.report.summary).toBe('boom-string');
    expect(requests[0]?.report.description).toBeUndefined();
  });

  it('self-skips where the target has no addEventListener (non-edge runtime) — no throw', () => {
    const provider = createEdgeUnhandledRejectionProvider({}); // no add/removeEventListener
    expect(() => provider.start({} as Client, () => {})).not.toThrow();
    expect(() => provider.stop()).not.toThrow();
  });
});
