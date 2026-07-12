import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrashpadSessionMarker } from '@bugsee/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeCrashpadSessionMarkerStore } from './crashpad-session-marker-store';

const FILE = 'crashpad-session.json';

const marker = (over: Partial<CrashpadSessionMarker> = {}): CrashpadSessionMarker => ({
  generation: 1700,
  sessionId: 'sess-abc',
  dumpDir: '/crashpad/db',
  attributes: { build: '30.1' },
  userIdentifier: 'u@x.io',
  ...over,
});

describe('createNodeCrashpadSessionMarkerStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bugsee-cps-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists the marker as a single JSON file and reads it back', () => {
    const store = createNodeCrashpadSessionMarkerStore(dir);
    store.put(marker());
    expect(readFileSync(join(dir, FILE), 'utf8')).toContain('"sess-abc"');
    expect(store.read()).toEqual(marker());
  });

  it('creates the directory if missing', () => {
    const nested = join(dir, 'a', 'incidents');
    const store = createNodeCrashpadSessionMarkerStore(nested);
    store.put(marker({ sessionId: 's2' }));
    expect(store.read()?.sessionId).toBe('s2');
  });

  it('read() returns undefined (and does NOT route to onError) when no marker was ever written', () => {
    const onError = vi.fn();
    expect(createNodeCrashpadSessionMarkerStore(dir, onError).read()).toBeUndefined();
    expect(onError).not.toHaveBeenCalled(); // absence is not a corruption
  });

  it('put() replaces a prior marker (single-slot, not a list)', () => {
    const store = createNodeCrashpadSessionMarkerStore(dir);
    store.put(marker({ generation: 1 }));
    store.put(marker({ generation: 2 }));
    expect(store.read()?.generation).toBe(2);
  });

  it('remove() deletes the marker so a later read() is undefined', () => {
    const store = createNodeCrashpadSessionMarkerStore(dir);
    store.put(marker());
    store.remove();
    expect(store.read()).toBeUndefined();
  });

  it('remove() is a no-op when there is no marker', () => {
    expect(() => createNodeCrashpadSessionMarkerStore(dir).remove()).not.toThrow();
  });

  it('read() swallows a corrupt marker with the default (no-op) onError — returns undefined, no throw', () => {
    const store = createNodeCrashpadSessionMarkerStore(dir); // default onError
    writeFileSync(join(dir, FILE), '{bad');
    expect(store.read()).toBeUndefined();
    expect(store.read()).toBeUndefined(); // purged, still fine
  });

  it('read() routes a corrupt marker to onError, purges it, and returns undefined', () => {
    const onError = vi.fn();
    const store = createNodeCrashpadSessionMarkerStore(dir, onError);
    writeFileSync(join(dir, FILE), 'NOT-JSON');
    expect(store.read()).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    // Purged, so a second read does not repeat the failure.
    expect(store.read()).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
