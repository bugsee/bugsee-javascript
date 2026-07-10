import { describe, expect, it, vi } from 'vitest';
import {
  BUGSEE_BRIDGE_KEY,
  BUGSEE_CONTROL_CHANNEL,
  BUGSEE_HELLO_CHANNEL,
  BUGSEE_STREAM_CHANNEL,
  type BugseeElectronBridge,
  registerBugseePreload,
} from './preload-bridge';

function fakeElectron() {
  const exposed: Array<{ key: string; api: BugseeElectronBridge }> = [];
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  return {
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, api: unknown) => {
        exposed.push({ key, api: api as BugseeElectronBridge });
      }),
    },
    ipcRenderer: {
      send: vi.fn((channel: string, ...args: unknown[]) => {
        sent.push({ channel, args });
      }),
      on: vi.fn((channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
        listeners.set(channel, listener);
      }),
    },
    exposed,
    sent,
    listeners,
  };
}

describe('registerBugseePreload', () => {
  it('exposes __bugseeElectron with post/sendHello/onControl into the main world', () => {
    const e = fakeElectron();
    registerBugseePreload(e);
    expect(e.exposed[0]?.key).toBe(BUGSEE_BRIDGE_KEY);
    expect(typeof e.exposed[0]?.api.post).toBe('function');
    expect(typeof e.exposed[0]?.api.sendHello).toBe('function');
    expect(typeof e.exposed[0]?.api.onControl).toBe('function');
  });

  it('the exposed post() forwards to ipcRenderer.send on the stream channel', () => {
    const e = fakeElectron();
    registerBugseePreload(e);
    e.exposed[0]?.api.post('{"k":"entry"}');
    expect(e.sent[0]).toEqual({ channel: BUGSEE_STREAM_CHANNEL, args: ['{"k":"entry"}'] });
  });

  it('the exposed sendHello() forwards to ipcRenderer.send on the hello channel', () => {
    const e = fakeElectron();
    registerBugseePreload(e);
    e.exposed[0]?.api.sendHello('{"k":"hello"}');
    expect(e.sent[0]).toEqual({ channel: BUGSEE_HELLO_CHANNEL, args: ['{"k":"hello"}'] });
  });

  it('onControl subscribes to the control channel and forwards string payloads to the handler', () => {
    const e = fakeElectron();
    registerBugseePreload(e);
    const handler = vi.fn();
    e.exposed[0]?.api.onControl(handler);
    const listener = e.listeners.get(BUGSEE_CONTROL_CHANNEL);
    expect(listener).toBeTypeOf('function');
    listener?.({}, '{"k":"control","c":"pause"}');
    expect(handler).toHaveBeenCalledWith('{"k":"control","c":"pause"}');
  });

  it('onControl ignores a non-string control payload (never forwards garbage)', () => {
    const e = fakeElectron();
    registerBugseePreload(e);
    const handler = vi.fn();
    e.exposed[0]?.api.onControl(handler);
    e.listeners.get(BUGSEE_CONTROL_CHANNEL)?.({}, { not: 'a string' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('honours channel + key overrides', () => {
    const e = fakeElectron();
    registerBugseePreload({
      ...e,
      channel: 'x:chan',
      helloChannel: 'x:hello',
      controlChannel: 'x:ctl',
      key: '__custom',
    });
    expect(e.exposed[0]?.key).toBe('__custom');
    e.exposed[0]?.api.post('m');
    expect(e.sent[0]?.channel).toBe('x:chan');
    e.exposed[0]?.api.sendHello('h');
    expect(e.sent[1]?.channel).toBe('x:hello');
    e.exposed[0]?.api.onControl(vi.fn());
    expect(e.listeners.has('x:ctl')).toBe(true);
  });

  it('uses the same global key the renderer reads (__bugseeElectron)', () => {
    // Guards the renderer↔preload contract: launch-renderer.ts reads globalThis.__bugseeElectron.
    expect(BUGSEE_BRIDGE_KEY).toBe('__bugseeElectron');
  });
});
