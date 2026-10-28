import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as preload from './preload';

describe('@bugsee/electron/preload entry', () => {
  it('re-exports the preload API + shared constants', () => {
    expect(typeof preload.registerBugseePreload).toBe('function');
    expect(preload.BUGSEE_BRIDGE_KEY).toBe('__bugseeElectron');
    expect(preload.BUGSEE_STREAM_CHANNEL).toBe('bugsee:stream');
    expect(preload.BUGSEE_HELLO_CHANNEL).toBe('bugsee:hello');
    expect(preload.BUGSEE_CONTROL_CHANNEL).toBe('bugsee:control');
  });
});

// Electron 45 removed the events, timers and url modules and the Buffer, setImmediate and
// clearImmediate globals from sandboxed preloads, which also cannot load sibling files. The preload
// entry must stay a pure contextBridge + ipcRenderer wrapper (#110).
describe('@bugsee/electron/preload sandbox safety', () => {
  const read = (f: string): string => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
  // Comments mention `require` and `process` in prose; only code matters.
  const bridge = read('./preload-bridge.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const entry = read('./preload.ts');

  it('imports nothing but its own bridge module', () => {
    expect(bridge).not.toMatch(/^\s*import\s/m);
    expect(bridge).not.toMatch(/require\(/);
    expect([...entry.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['./preload-bridge']);
  });

  it('references none of the removed polyfill globals', () => {
    expect(bridge).not.toMatch(/\b(Buffer|setImmediate|clearImmediate|process)\b/);
  });
});
