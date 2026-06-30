import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostBridge } from './host-bridge';

// A fake Android @JavascriptInterface global: `window.BugseeBridge.post(raw)`.
const withBridge = (post: (raw: string) => void) => ({ BugseeBridge: { post } });

afterEach(() => vi.unstubAllGlobals());

describe('createHostBridge', () => {
  it('posts the raw wire string to the native BugseeBridge.post', () => {
    const posted: string[] = [];
    const bridge = createHostBridge({ global: withBridge((r) => posted.push(r)) });
    expect(bridge.available).toBe(true);
    bridge.post('{"k":"hello"}');
    expect(posted).toEqual(['{"k":"hello"}']);
  });

  it('reports unavailable + buffers when no native bridge is attached yet', () => {
    const global: { BugseeBridge?: { post(raw: string): void } } = {};
    const bridge = createHostBridge({ global });
    expect(bridge.available).toBe(false);
    expect(() => bridge.post('a')).not.toThrow(); // buffered, never throws
  });

  it('flushes buffered messages (in order) the moment the bridge attaches', () => {
    const global: { BugseeBridge?: { post(raw: string): void } } = {};
    const bridge = createHostBridge({ global });
    bridge.post('a');
    bridge.post('b');
    const posted: string[] = [];
    global.BugseeBridge = { post: (r) => posted.push(r) }; // native attaches late
    bridge.post('c');
    expect(posted).toEqual(['a', 'b', 'c']); // backlog flushed first, then the new one
  });

  it('bounds the buffer, evicting the OLDEST when full (FIFO)', () => {
    const global: { BugseeBridge?: { post(raw: string): void } } = {};
    const bridge = createHostBridge({ global, maxBuffer: 2 });
    bridge.post('a');
    bridge.post('b');
    bridge.post('c'); // overflow → 'a' evicted
    const posted: string[] = [];
    global.BugseeBridge = { post: (r) => posted.push(r) };
    bridge.post('d');
    expect(posted).toEqual(['b', 'c', 'd']); // 'a' dropped
  });

  it('routes a native post failure to onError without throwing', () => {
    const onError = vi.fn();
    const bridge = createHostBridge({
      global: withBridge(() => {
        throw new Error('jni boom');
      }),
      onError,
    });
    expect(() => bridge.post('a')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('jni boom');
  });

  it('swallows a post failure with the default no-op onError (no onError supplied)', () => {
    const bridge = createHostBridge({
      global: withBridge(() => {
        throw new Error('boom');
      }),
    });
    expect(() => bridge.post('a')).not.toThrow();
  });

  it('defaults the global to globalThis', () => {
    const posted: string[] = [];
    vi.stubGlobal('BugseeBridge', { post: (r: string) => posted.push(r) });
    const bridge = createHostBridge();
    bridge.post('x');
    expect(posted).toEqual(['x']);
  });
});
