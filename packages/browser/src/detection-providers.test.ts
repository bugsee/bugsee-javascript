import type { Client, ReportingRequest } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUnhandledRejectionProvider,
  createWindowErrorProvider,
  type WindowEvents,
} from './detection-providers';

// A fake window event target: records listeners by type and can dispatch synthetic events.
function fakeWindow() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const win: WindowEvents = {
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
    win,
    emit: (type: string, event: unknown) => {
      for (const l of listeners.get(type) ?? []) {
        l(event as Event);
      }
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

const dummyClient = {} as Client;

function started(provider: ReturnType<typeof createWindowErrorProvider>) {
  const requests: ReportingRequest[] = [];
  provider.start(dummyClient, (r) => requests.push(r));
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWindowErrorProvider', () => {
  it('registers on the window error event', () => {
    const w = fakeWindow();
    started(createWindowErrorProvider(w.win));
    expect(w.count('error')).toBe(1);
    expect(w.count('unhandledrejection')).toBe(0);
  });

  it('has the stable provider name', () => {
    expect(createWindowErrorProvider(fakeWindow().win).name).toBe('browser-window-error');
  });

  it('reports a crash (mechanism uncaught) with summary + scrubbed stack from event.error', () => {
    const w = fakeWindow();
    const requests = started(createWindowErrorProvider(w.win));
    const err = new Error('boom');
    err.stack = 'doWork@https://app.test/work.js:3:7'; // Firefox dialect
    w.emit('error', { error: err });
    expect(requests).toHaveLength(1);
    const req = requests[0] as ReportingRequest;
    expect(req.source).toEqual({ type: 'crash', mechanism: 'uncaught' });
    expect(req.report.type).toBe('crash');
    expect(req.report.summary).toBe('boom');
    expect(req.report.description).toBe('    at doWork (https://app.test/work.js:3:7)');
    // SC3: crash.json attached (handled:false), parsed with the browser's multi-engine parser (Firefox dialect).
    expect(req.report.crash?.handled).toBe(false);
    expect(req.report.crash?.exception.frames[0]?.trace).toBe('at doWork (https://app.test/work.js:3:7)');
  });

  it('stamps a source-map debug-ID (debugId=) when the bundle registered one', () => {
    const g = globalThis as { _bugseeDebugIds?: Record<string, string> };
    const prev = g._bugseeDebugIds;
    // the injected stub's Error().stack — its top frame is the bundle's own file
    g._bugseeDebugIds = { 'Error\n    at reg (https://app.test/work.js:1:1)': 'dbg-77' };
    try {
      const w = fakeWindow();
      const requests = started(createWindowErrorProvider(w.win));
      const err = new Error('boom');
      err.stack = 'Error\n    at doWork (https://app.test/work.js:3:7)'; // V8 dialect
      w.emit('error', { error: err });
      const req = requests[0] as ReportingRequest;
      expect(req.report.description).toContain('debugId=dbg-77');
      // and the structured crash.json carries the per-frame debug_id (the worker's join key).
      expect(req.report.crash?.exception.frames[0]?.debug_id).toBe('dbg-77');
    } finally {
      if (prev === undefined) delete g._bugseeDebugIds;
      else g._bugseeDebugIds = prev;
    }
  });

  it('falls back to message + filename:lineno:colno when event.error is absent (no crash.json)', () => {
    const w = fakeWindow();
    const requests = started(createWindowErrorProvider(w.win));
    w.emit('error', {
      error: null,
      message: 'Uncaught ReferenceError: x is not defined',
      filename: 'https://app.test/page.js',
      lineno: 12,
      colno: 5,
    });
    expect(requests[0]?.report.summary).toBe('Uncaught ReferenceError: x is not defined');
    expect(requests[0]?.report.description).toBe(
      '    at <anonymous> (https://app.test/page.js:12:5)',
    );
    expect(requests[0]?.report.crash).toBeUndefined(); // cross-origin: no thrown Error → no crash.json
  });

  it('falls back to message when event.error is undefined (not just null)', () => {
    const w = fakeWindow();
    const requests = started(createWindowErrorProvider(w.win));
    // Some events carry `error: undefined` rather than `null`; the guard must treat both as "no error".
    w.emit('error', {
      error: undefined,
      message: 'Uncaught X',
      filename: 'https://app.test/p.js',
      lineno: 1,
      colno: 2,
    });
    expect(requests[0]?.report.summary).toBe('Uncaught X'); // not the string "undefined"
    expect(requests[0]?.report.description).toBe('    at <anonymous> (https://app.test/p.js:1:2)');
  });

  it('omits the description for a cross-origin "Script error." (no error, no filename)', () => {
    const w = fakeWindow();
    const requests = started(createWindowErrorProvider(w.win));
    w.emit('error', { error: null, message: 'Script error.', filename: '', lineno: 0, colno: 0 });
    expect(requests[0]?.report.summary).toBe('Script error.');
    expect(requests[0]?.report.description).toBeUndefined();
  });

  it('uses String(value) and no description for a non-Error thrown value', () => {
    const w = fakeWindow();
    const requests = started(createWindowErrorProvider(w.win));
    w.emit('error', { error: 'just a string' });
    expect(requests[0]?.report.summary).toBe('just a string');
    expect(requests[0]?.report.description).toBeUndefined();
  });

  it('falls back to the error name, and omits the description, when message/stack are absent', () => {
    const w = fakeWindow();
    const requests = started(createWindowErrorProvider(w.win));
    const err = new TypeError('');
    err.stack = undefined;
    w.emit('error', { error: err });
    expect(requests[0]?.report.summary).toBe('TypeError');
    expect(requests[0]?.report.description).toBeUndefined();
  });

  it('deregisters on stop (no report after stop)', () => {
    const w = fakeWindow();
    const provider = createWindowErrorProvider(w.win);
    const requests = started(provider);
    provider.stop();
    expect(w.count('error')).toBe(0);
    w.emit('error', { error: new Error('late') });
    expect(requests).toHaveLength(0);
  });

  it('defaults to the global window', () => {
    const w = fakeWindow();
    vi.stubGlobal('window', w.win);
    const provider = createWindowErrorProvider();
    provider.start(dummyClient, () => {});
    expect(w.count('error')).toBe(1);
    provider.stop();
    expect(w.count('error')).toBe(0);
  });
});

describe('createUnhandledRejectionProvider', () => {
  it('registers on the window unhandledrejection event', () => {
    const w = fakeWindow();
    started(createUnhandledRejectionProvider(w.win));
    expect(w.count('unhandledrejection')).toBe(1);
  });

  it('has the stable provider name', () => {
    expect(createUnhandledRejectionProvider(fakeWindow().win).name).toBe(
      'browser-unhandled-rejection',
    );
  });

  it('reports an error (mechanism unhandledrejection) with summary + stack from event.reason', () => {
    const w = fakeWindow();
    const requests = started(createUnhandledRejectionProvider(w.win));
    const reason = new Error('rejected');
    reason.stack = 'Error: rejected\n    at f (https://app.test/a.js:1:2)'; // V8 dialect
    w.emit('unhandledrejection', { reason });
    const req = requests[0] as ReportingRequest;
    expect(req.source).toEqual({ type: 'error', mechanism: 'unhandledrejection' });
    expect(req.report.type).toBe('error');
    expect(req.report.summary).toBe('rejected');
    expect(req.report.description).toBe('    at f (https://app.test/a.js:1:2)');
    expect(req.report.crash?.exception.frames[0]?.trace).toBe('at f (https://app.test/a.js:1:2)'); // SC3
  });

  it('handles a non-Error rejection reason (no crash.json)', () => {
    const w = fakeWindow();
    const requests = started(createUnhandledRejectionProvider(w.win));
    w.emit('unhandledrejection', { reason: { code: 42 } });
    expect(requests[0]?.report.summary).toBe('[object Object]');
    expect(requests[0]?.report.description).toBeUndefined();
    expect(requests[0]?.report.crash).toBeUndefined();
  });

  it('defaults to the global window', () => {
    const w = fakeWindow();
    vi.stubGlobal('window', w.win);
    const provider = createUnhandledRejectionProvider();
    provider.start(dummyClient, () => {});
    expect(w.count('unhandledrejection')).toBe(1);
    provider.stop();
    expect(w.count('unhandledrejection')).toBe(0);
  });
});
