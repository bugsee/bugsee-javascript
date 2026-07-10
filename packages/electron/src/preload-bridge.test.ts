import { describe, expect, it, vi } from 'vitest';
import { BUGSEE_BRIDGE_KEY, BUGSEE_STREAM_CHANNEL, registerBugseePreload } from './preload-bridge';

function fakeElectron() {
  const exposed: Array<{ key: string; api: { post: (raw: string) => void } }> = [];
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  return {
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, api: unknown) => {
        exposed.push({ key, api: api as { post: (raw: string) => void } });
      }),
    },
    ipcRenderer: {
      send: vi.fn((channel: string, ...args: unknown[]) => {
        sent.push({ channel, args });
      }),
    },
    exposed,
    sent,
  };
}

describe('registerBugseePreload', () => {
  it('exposes __bugseeElectron.post into the main world', () => {
    const e = fakeElectron();
    registerBugseePreload(e);
    expect(e.exposed[0]?.key).toBe(BUGSEE_BRIDGE_KEY);
    expect(typeof e.exposed[0]?.api.post).toBe('function');
  });

  it('the exposed post() forwards to ipcRenderer.send on the stream channel', () => {
    const e = fakeElectron();
    registerBugseePreload(e);
    e.exposed[0]?.api.post('{"k":"entry"}');
    expect(e.sent[0]).toEqual({ channel: BUGSEE_STREAM_CHANNEL, args: ['{"k":"entry"}'] });
  });

  it('honours channel + key overrides', () => {
    const e = fakeElectron();
    registerBugseePreload({ ...e, channel: 'x:chan', key: '__custom' });
    expect(e.exposed[0]?.key).toBe('__custom');
    e.exposed[0]?.api.post('m');
    expect(e.sent[0]?.channel).toBe('x:chan');
  });

  it('uses the same global key the renderer reads (__bugseeElectron)', () => {
    // Guards the renderer↔preload contract: launch-renderer.ts reads globalThis.__bugseeElectron.
    expect(BUGSEE_BRIDGE_KEY).toBe('__bugseeElectron');
  });
});
