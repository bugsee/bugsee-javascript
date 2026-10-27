import { describe, expect, it, vi } from 'vitest';
import {
  createTraceSuppression,
  ELECTRON_RENDERER_HOST_OWNED_TRACES,
  isTraceSuppression,
  sanitizeTraceNames,
  WEBVIEW_HOST_OWNED_TRACES,
} from './trace-suppression';

describe('createTraceSuppression', () => {
  it('starts empty and answers has() for no name', () => {
    const s = createTraceSuppression();
    expect(s.has('battery')).toBe(false);
    expect(s.names()).toEqual([]);
  });

  it('starts from the given layers', () => {
    const s = createTraceSuppression({ host: ['displays', 'capture'], window: ['url'] });
    expect(s.has('displays')).toBe(true);
    expect(s.has('url')).toBe(true);
    expect(s.has('battery')).toBe(false);
    expect(s.names().sort()).toEqual(['capture', 'displays', 'url']);
  });

  it('a name is suppressed while ANY layer lists it', () => {
    const s = createTraceSuppression({ host: ['a'], window: ['a', 'b'] });
    s.setLayer('host', []);
    expect(s.has('a')).toBe(true); // still listed by `window`
    s.setLayer('window', ['b']);
    expect(s.has('a')).toBe(false);
    expect(s.has('b')).toBe(true);
  });

  it('setLayer REPLACES that layer (it can both add and remove names) and leaves the others alone', () => {
    const s = createTraceSuppression({ host: ['a', 'b'], window: ['w'] });
    s.setLayer('host', ['b', 'c']);
    expect(s.names().sort()).toEqual(['b', 'c', 'w']);
  });

  it('names() is a copy: mutating it never changes the suppression', () => {
    const s = createTraceSuppression({ host: ['a'] });
    s.names().push('zzz');
    expect(s.has('zzz')).toBe(false);
    expect(s.names()).toEqual(['a']);
  });

  it('the layer arrays handed in are copied (a later mutation of the caller array changes nothing)', () => {
    const names = ['a'];
    const s = createTraceSuppression({ host: names });
    names.push('b');
    expect(s.has('b')).toBe(false);
    const next = ['x'];
    s.setLayer('host', next);
    next.push('y');
    expect(s.has('y')).toBe(false);
  });

  it('does not treat inherited Object.prototype keys as suppressed names', () => {
    const s = createTraceSuppression({ host: ['a'] });
    expect(s.has('toString')).toBe(false);
    expect(s.has('constructor')).toBe(false);
    expect(s.has('__proto__')).toBe(false);
  });

  describe('subscribe', () => {
    it('notifies with the names a change RELEASED (were suppressed, are not any more), and only those', () => {
      const s = createTraceSuppression({ host: ['a', 'b'] });
      const seen = vi.fn();
      s.subscribe(seen);
      s.setLayer('host', ['b', 'c']); // a released, c newly suppressed
      expect(seen).toHaveBeenCalledExactlyOnceWith(['a']);
    });

    it('does not notify when nothing was released (adding names, or an identical replace)', () => {
      const s = createTraceSuppression({ host: ['a'] });
      const seen = vi.fn();
      s.subscribe(seen);
      s.setLayer('host', ['a', 'b']);
      s.setLayer('host', ['a', 'b']);
      expect(seen).not.toHaveBeenCalled();
    });

    it('a name still listed by another layer is not released', () => {
      const s = createTraceSuppression({ host: ['a'], window: ['a'] });
      const seen = vi.fn();
      s.subscribe(seen);
      s.setLayer('host', []);
      expect(seen).not.toHaveBeenCalled();
      s.setLayer('window', []);
      expect(seen).toHaveBeenCalledExactlyOnceWith(['a']);
    });

    it('the unsubscribe stops notifications; a throwing listener never breaks the change or the other listeners', () => {
      const s = createTraceSuppression({ host: ['a'] });
      const bad = vi.fn(() => {
        throw new Error('listener');
      });
      const good = vi.fn();
      const off = s.subscribe(good);
      s.subscribe(bad);
      expect(() => s.setLayer('host', [])).not.toThrow();
      expect(good).toHaveBeenCalledOnce();
      expect(bad).toHaveBeenCalledOnce();
      expect(s.has('a')).toBe(false);
      off();
      s.setLayer('host', ['a']);
      s.setLayer('host', []);
      expect(good).toHaveBeenCalledOnce();
    });
  });
});

describe('isTraceSuppression', () => {
  it('recognises the live object and nothing else', () => {
    expect(isTraceSuppression(createTraceSuppression())).toBe(true);
    for (const v of [undefined, null, 1, 'a', ['a'], {}, { has: () => true }]) {
      expect(isTraceSuppression(v)).toBe(false);
    }
  });

  it.each([
    'has',
    'names',
    'setLayer',
    'subscribe',
  ] as const)('needs `%s` (a look-alike without it is not one)', (missing) => {
    const real = createTraceSuppression() as unknown as Record<string, unknown>;
    const lookalike = { ...real };
    delete lookalike[missing];
    expect(isTraceSuppression(lookalike)).toBe(false);
    expect(isTraceSuppression(real)).toBe(true);
  });
});

describe('sanitizeTraceNames (names that arrive over a wire)', () => {
  it('keeps an array of plausible trace names', () => {
    expect(sanitizeTraceNames(['battery', 'ram_js_heap_total'])).toEqual([
      'battery',
      'ram_js_heap_total',
    ]);
    expect(sanitizeTraceNames([])).toEqual([]);
  });

  it('rejects (undefined) anything that is not an array of short non-empty strings', () => {
    for (const bad of [
      undefined,
      null,
      'battery',
      1,
      {},
      [1],
      [''],
      [null],
      ['a', 2],
      ['x'.repeat(65)],
    ]) {
      expect(sanitizeTraceNames(bad)).toBeUndefined();
    }
  });

  it('accepts the 64-character boundary and at most 64 names', () => {
    expect(sanitizeTraceNames(['x'.repeat(64)])).toEqual(['x'.repeat(64)]);
    const sixtyFour = Array.from({ length: 64 }, (_, i) => `t${i}`);
    expect(sanitizeTraceNames(sixtyFour)).toEqual(sixtyFour);
    expect(sanitizeTraceNames([...sixtyFour, 'one-more'])).toBeUndefined();
  });

  it('returns a copy, never the input array', () => {
    const input = ['a'];
    const out = sanitizeTraceNames(input);
    expect(out).not.toBe(input);
  });
});

describe('the per-host tables (spec platforms/javascript.md "Host-owned traces")', () => {
  it('Electron renderer: only displays, capture and the three ram_js_heap_* are host-owned (main writes them)', () => {
    expect([...ELECTRON_RENDERER_HOST_OWNED_TRACES].sort()).toEqual([
      'capture',
      'displays',
      'ram_js_heap_free',
      'ram_js_heap_total',
      'ram_js_heap_used',
    ]);
  });

  it('WebView: the native host writes device state, display and capture; page-owned traces are NOT listed', () => {
    expect([...WEBVIEW_HOST_OWNED_TRACES].sort()).toEqual([
      'app_state',
      'battery',
      'battery_charging_time_s',
      'battery_discharging_time_s',
      'capture',
      'charging',
      'connection',
      'displays',
      'fps',
      'orientation',
      'ram_system_advertised',
      'view',
    ]);
    for (const pageOwned of [
      'url',
      'route',
      'storage_estimate',
      'main_thread_lag_ms',
      'main_thread_idle_ms',
      'user_idle_state',
      'ram_js_heap_total',
    ]) {
      expect(WEBVIEW_HOST_OWNED_TRACES).not.toContain(pageOwned);
    }
  });
});
