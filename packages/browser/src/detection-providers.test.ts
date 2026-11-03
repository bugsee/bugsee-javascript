import { createAsyncOriginReporting, installAsyncOrigins } from '@bugsee/capture';
import type { Client, CrashJson, ReportingRequest } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createUnhandledRejectionProvider,
  createWindowErrorProvider,
  type WindowEvents,
} from './detection-providers';
import { parseStack } from './stack';

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
    expect((req.report.crash as CrashJson | undefined)?.handled).toBe(false);
    expect((req.report.crash as CrashJson | undefined)?.exception.frames[0]?.trace).toBe(
      'at doWork (https://app.test/work.js:3:7)',
    );
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
      expect((req.report.crash as CrashJson | undefined)?.exception.frames[0]?.debug_id).toBe(
        'dbg-77',
      );
    } finally {
      if (prev === undefined) delete g._bugseeDebugIds;
      else g._bugseeDebugIds = prev;
    }
  });

  it('falls back to message + filename:lineno:colno when event.error is absent', () => {
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
    // Cross-origin "Script error." carries no thrown value, so the crash is synthesised from what the
    // EVENT knows — not from the absent value, whose synthetic form would say only "Null".
    expect(requests[0]?.report.crash).toMatchObject({
      exception_type: 'error',
      handled: false,
      exception: {
        name: 'Error',
        reason: 'Uncaught ReferenceError: x is not defined',
        frames: [{ trace: 'at <anonymous> (https://app.test/page.js:12:5)', user: true }],
      },
    });
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

  it('gives every cross-origin "Script error." the SAME single frame, so they group into one issue', () => {
    // With no thrown value and no filename the crash used to carry ZERO frames, and an issue is grouped on
    // its frames — so every occurrence was an issue of its own. The page genuinely cannot say more (that
    // is what "Script error." means), so the one honest, STABLE frame is "a cross-origin script".
    const w = fakeWindow();
    const requests = started(createWindowErrorProvider(w.win));
    for (const lineno of [0, 5, 99]) {
      w.emit('error', {
        error: null,
        message: 'Script error.',
        filename: '',
        lineno,
        colno: lineno,
      });
    }

    const frames = requests.map(
      (r) => (r.report.crash as { exception: { frames: unknown[] } }).exception.frames,
    );
    expect(frames[0]).toEqual([{ trace: 'at <cross-origin script>', user: true }]);
    expect(frames[1]).toEqual(frames[0]);
    expect(frames[2]).toEqual(frames[0]);
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
    expect((req.report.crash as CrashJson | undefined)?.exception.frames[0]?.trace).toBe(
      'at f (https://app.test/a.js:1:2)',
    ); // SC3
  });

  it('handles a non-Error rejection reason', () => {
    const w = fakeWindow();
    const requests = started(createUnhandledRejectionProvider(w.win));
    w.emit('unhandledrejection', { reason: { code: 42 } });
    expect(requests[0]?.report.summary).toBe('Object: {"code":42}');
    expect(requests[0]?.report.description).toBeUndefined();
    // A rejected non-Error still gets a usable crash document.
    expect(requests[0]?.report.crash).toMatchObject({
      handled: false,
      exception: { name: 'Object', reason: '{"code":42}' },
    });
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

describe('async origin (a stackless platform rejection reported WITH its call site)', () => {
  // A DOMException from an async media task: an Error, with no stack at all (BGSVIEWER-14).
  const stacklessError = (): Error => {
    const e = new Error('The element has no supported sources');
    e.name = 'NotSupportedError';
    Object.defineProperty(e, 'stack', { value: undefined });
    return e;
  };

  // A recorder over a fake realm whose `play()` rejects with `reason`; returns the reason after it passed through the wrapper.
  async function located(reason: Error) {
    class Media {
      tagName = 'VIDEO';
      id = 'hero';
      networkState = 3;
      readyState = 0;
      play(): Promise<void> {
        return Promise.reject(reason);
      }
    }
    const recorder = installAsyncOrigins({
      global: { HTMLMediaElement: Media, Promise, Error },
      rows: [{ iface: 'HTMLMediaElement', methods: ['play'], mode: 'always', why: 'test' }],
    });
    const origins = createAsyncOriginReporting(recorder, parseStack);
    function startPlayback(): Promise<void> {
      return new Media().play();
    }
    await startPlayback().catch(() => undefined);
    return { origins, recorder };
  }

  it('puts the call-site frames in crash.json and the description, marked origin: call, with the target', async () => {
    const reason = stacklessError();
    const { origins, recorder } = await located(reason);
    const w = fakeWindow();
    const requests = started(createUnhandledRejectionProvider(w.win, origins));
    w.emit('unhandledrejection', { reason });
    const req = requests[0] as ReportingRequest;
    const frames = (req.report.crash as CrashJson).exception.frames;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.origin === 'call')).toBe(true);
    expect(frames.some((f) => f.trace.includes('startPlayback'))).toBe(true);
    expect(req.report.summary).toBe('The element has no supported sources');
    expect(req.report.description).toContain('startPlayback');
    expect(req.report.description).toContain(
      'Target: <video id="hero"> networkState=3 readyState=0',
    );
    recorder.stop();
  });

  it('treats a header-only stack (Chromium async DOMException) as stackless: the description still names the call site and the target', async () => {
    const reason = stacklessError();
    Object.defineProperty(reason, 'stack', {
      value: 'NotSupportedError: The element has no supported sources',
    });
    const { origins, recorder } = await located(reason);
    const w = fakeWindow();
    const requests = started(createUnhandledRejectionProvider(w.win, origins));
    w.emit('unhandledrejection', { reason });
    const req = requests[0] as ReportingRequest;
    expect(req.report.description).toContain('startPlayback');
    expect(req.report.description).toContain('Target: <video id="hero">');
    recorder.stop();
  });

  it('does the same for an error that reached the window error event (a React root with no boundary)', async () => {
    const reason = stacklessError();
    const { origins, recorder } = await located(reason);
    const w = fakeWindow();
    const requests = started(createWindowErrorProvider(w.win, origins));
    w.emit('error', { error: reason, message: 'x', filename: '', lineno: 0, colno: 0 });
    const req = requests[0] as ReportingRequest;
    const frames = (req.report.crash as CrashJson).exception.frames;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.origin === 'call')).toBe(true);
    expect(req.report.description).toContain('Target: <video');
    recorder.stop();
  });

  it('also describes a NON-Error reason (a DOMException from another realm is not instanceof Error) by its recorded call site', async () => {
    const reason = { name: 'NotSupportedError', message: 'cross-realm' }; // no stack, not an Error
    class Media {
      tagName = 'VIDEO';
      id = 'hero';
      play(): Promise<unknown> {
        return Promise.reject(reason);
      }
    }
    const recorder = installAsyncOrigins({
      global: { HTMLMediaElement: Media, Promise, Error },
      rows: [{ iface: 'HTMLMediaElement', methods: ['play'], mode: 'always', why: 'test' }],
    });
    const origins = createAsyncOriginReporting(recorder, parseStack);
    function startPlayback(): Promise<unknown> {
      return new Media().play();
    }
    await startPlayback().catch(() => undefined);
    const w = fakeWindow();
    const requests = started(createUnhandledRejectionProvider(w.win, origins));
    w.emit('unhandledrejection', { reason });
    const req = requests[0] as ReportingRequest;
    expect(req.report.description).toContain('startPlayback');
    expect(req.report.description).toContain('Target: <video id="hero">');
    // The grouping signature comes from crash.json: no frames there means every occurrence is its own issue.
    const frames = (req.report.crash as CrashJson).exception.frames;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.origin === 'call')).toBe(true);
    expect(frames[0]?.trace).toContain('startPlayback');
    recorder.stop();
  });

  it('uses event.promise when the recorder could attach no reaction (fallback mode keys the origin by promise)', async () => {
    const reason = stacklessError();
    class Media {
      tagName = 'VIDEO';
      id = 'hero';
      play(): Promise<void> {
        return Promise.reject(reason);
      }
    }
    const recorder = installAsyncOrigins({
      global: { HTMLMediaElement: Media, Promise, Error },
      rows: [{ iface: 'HTMLMediaElement', methods: ['play'], mode: 'always', why: 'test' }],
      cleanThen: null, // no pristine then anywhere: no reaction, the origin is keyed by the promise
    });
    const origins = createAsyncOriginReporting(recorder, parseStack);
    function startPlayback(): Promise<void> {
      return new Media().play();
    }
    const promise = startPlayback();
    promise.catch(() => undefined);
    const w = fakeWindow();
    const requests = started(createUnhandledRejectionProvider(w.win, origins));
    w.emit('unhandledrejection', { reason, promise });
    const req = requests[0] as ReportingRequest;
    const frames = (req.report.crash as CrashJson).exception.frames;
    expect(frames.some((f) => f.trace.includes('startPlayback'))).toBe(true);
    expect(req.report.description).toContain('startPlayback');
    recorder.stop();
  });

  it('arms the recorder when a stackless rejection arrives that nobody could locate', () => {
    const arm = vi.fn();
    const origins = createAsyncOriginReporting(
      {
        originOf: () => undefined,
        originOfPromise: () => undefined,
        adoptPromise: () => undefined,
        arm,
        installed: [],
        stop: () => undefined,
      },
      parseStack,
    );
    const w = fakeWindow();
    started(createUnhandledRejectionProvider(w.win, origins));
    w.emit('unhandledrejection', { reason: stacklessError() });
    expect(arm).toHaveBeenCalled(); // idempotent in the recorder; the description and the crash JSON both enrich
  });

  it('still arms for a rejected NON-Error object (describeError asks the recorder about it, and the enricher arms)', () => {
    const arm = vi.fn();
    const origins = createAsyncOriginReporting(
      {
        originOf: () => undefined,
        originOfPromise: () => undefined,
        adoptPromise: () => undefined,
        arm,
        installed: [],
        stop: () => undefined,
      },
      parseStack,
    );
    const w = fakeWindow();
    started(createUnhandledRejectionProvider(w.win, origins));
    w.emit('unhandledrejection', { reason: { name: 'NotSupportedError' } });
    expect(arm).toHaveBeenCalled();
  });

  it('arms for the window error event too (a React root with no boundary never raises unhandledrejection)', () => {
    const arm = vi.fn();
    const origins = createAsyncOriginReporting(
      {
        originOf: () => undefined,
        originOfPromise: () => undefined,
        adoptPromise: () => undefined,
        arm,
        installed: [],
        stop: () => undefined,
      },
      parseStack,
    );
    const w = fakeWindow();
    started(createWindowErrorProvider(w.win, origins));
    w.emit('error', { error: stacklessError(), message: 'x', filename: '', lineno: 0, colno: 0 });
    expect(arm).toHaveBeenCalled();
  });

  it('reports exactly as before when no origin support is given, or the reason is unknown to it', () => {
    const w = fakeWindow();
    const plain = started(createUnhandledRejectionProvider(w.win));
    w.emit('unhandledrejection', { reason: stacklessError() });
    expect(plain[0]?.report.description).toBeUndefined();
    expect((plain[0]?.report.crash as CrashJson).exception.frames).toEqual([]);
    const w2 = fakeWindow();
    const unknown = started(
      createUnhandledRejectionProvider(
        w2.win,
        createAsyncOriginReporting(
          {
            originOf: () => undefined,
            originOfPromise: () => undefined,
            adoptPromise: () => undefined,
            arm: () => undefined,
            installed: [],
            stop: () => undefined,
          },
          parseStack,
        ),
      ),
    );
    w2.emit('unhandledrejection', { reason: stacklessError() });
    expect(unknown[0]?.report.description).toBeUndefined();
  });

  it('leaves a rejection that has its own stack alone', async () => {
    const own = new Error('thrown');
    own.stack = 'Error: thrown\n    at f (https://app.test/a.js:1:2)';
    const { origins, recorder } = await located(own);
    const w = fakeWindow();
    const requests = started(createUnhandledRejectionProvider(w.win, origins));
    w.emit('unhandledrejection', { reason: own });
    expect((requests[0]?.report.crash as CrashJson).exception.frames[0]?.origin).toBeUndefined();
    expect(requests[0]?.report.description).toBe('    at f (https://app.test/a.js:1:2)');
    recorder.stop();
  });
});
