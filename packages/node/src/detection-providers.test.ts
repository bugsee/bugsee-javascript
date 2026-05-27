import type { Client, ReportingRequest } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import {
  createUncaughtExceptionProvider,
  createUnhandledRejectionProvider,
  type ProcessEvents,
} from './detection-providers';

// A fake process event emitter: records listeners by event and can fire them.
function fakeProcess() {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const proc: ProcessEvents = {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (value: unknown) => void);
      listeners.set(event, set);
      return proc;
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener as (value: unknown) => void);
      return proc;
    },
  };
  return {
    proc,
    emit: (event: string, value: unknown) => {
      for (const l of listeners.get(event) ?? []) {
        l(value);
      }
    },
    count: (event: string) => listeners.get(event)?.size ?? 0,
  };
}

const dummyClient = {} as Client;

function started(provider: ReturnType<typeof createUncaughtExceptionProvider>) {
  const requests: ReportingRequest[] = [];
  provider.start(dummyClient, (r) => requests.push(r));
  return requests;
}

describe('createUncaughtExceptionProvider', () => {
  it('registers on the uncaughtException event', () => {
    const p = fakeProcess();
    started(createUncaughtExceptionProvider(p.proc));
    expect(p.count('uncaughtException')).toBe(1);
    expect(p.count('unhandledRejection')).toBe(0);
  });

  it('reports a crash (mechanism uncaught) with summary + scrubbed stack on an Error', () => {
    const p = fakeProcess();
    const requests = started(createUncaughtExceptionProvider(p.proc));
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at doWork (file:///app/work.js:3:7)';
    p.emit('uncaughtException', err);
    expect(requests).toHaveLength(1);
    const req = requests[0] as ReportingRequest;
    expect(req.source).toEqual({ type: 'crash', mechanism: 'uncaught' });
    expect(req.report.type).toBe('crash');
    expect(req.report.summary).toBe('boom');
    expect(req.report.description).toBe('    at doWork (/app/work.js:3:7)'); // file:// stripped
  });

  it('uses String(value) and no description for a non-Error throw', () => {
    const p = fakeProcess();
    const requests = started(createUncaughtExceptionProvider(p.proc));
    p.emit('uncaughtException', 'just a string');
    expect(requests[0]?.report.summary).toBe('just a string');
    expect(requests[0]?.report.description).toBeUndefined();
  });

  it('falls back to the error name, and omits the description, when message/stack are absent', () => {
    const p = fakeProcess();
    const requests = started(createUncaughtExceptionProvider(p.proc));
    const err = new TypeError('');
    err.stack = undefined; // an Error with no stack must not be parsed (would throw) and yields no description
    p.emit('uncaughtException', err);
    expect(requests[0]?.report.summary).toBe('TypeError');
    expect(requests[0]?.report.description).toBeUndefined();
  });

  it('deregisters on stop (no report after stop)', () => {
    const p = fakeProcess();
    const provider = createUncaughtExceptionProvider(p.proc);
    const requests = started(provider);
    provider.stop();
    expect(p.count('uncaughtException')).toBe(0);
    p.emit('uncaughtException', new Error('late'));
    expect(requests).toHaveLength(0);
  });

  it('defaults to the global process', () => {
    const before = process.listenerCount('uncaughtException');
    const provider = createUncaughtExceptionProvider();
    provider.start(dummyClient, () => {});
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    provider.stop();
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });
});

describe('createUnhandledRejectionProvider', () => {
  it('registers on the unhandledRejection event', () => {
    const p = fakeProcess();
    started(createUnhandledRejectionProvider(p.proc));
    expect(p.count('unhandledRejection')).toBe(1);
  });

  it('reports an error (mechanism unhandledrejection) with summary + stack on an Error reason', () => {
    const p = fakeProcess();
    const requests = started(createUnhandledRejectionProvider(p.proc));
    const reason = new Error('rejected');
    reason.stack = 'Error: rejected\n    at f (/a.js:1:2)';
    p.emit('unhandledRejection', reason);
    const req = requests[0] as ReportingRequest;
    expect(req.source).toEqual({ type: 'error', mechanism: 'unhandledrejection' });
    expect(req.report.type).toBe('error');
    expect(req.report.summary).toBe('rejected');
    expect(req.report.description).toBe('    at f (/a.js:1:2)');
  });

  it('handles a non-Error rejection reason', () => {
    const p = fakeProcess();
    const requests = started(createUnhandledRejectionProvider(p.proc));
    p.emit('unhandledRejection', { code: 42 });
    expect(requests[0]?.report.summary).toBe('[object Object]');
    expect(requests[0]?.report.description).toBeUndefined();
  });

  it('defaults to the global process', () => {
    const before = process.listenerCount('unhandledRejection');
    const provider = createUnhandledRejectionProvider();
    provider.start(dummyClient, () => {});
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    provider.stop();
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });
});
