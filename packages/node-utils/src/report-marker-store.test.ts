import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReportMarker } from '@bugsee/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remove } from './fs-storage';
import { createNodeReportMarkerStore } from './report-marker-store';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-marker-test-'));
});
afterEach(() => {
  remove(root);
});

const marker = (id: string, generation = 5): ReportMarker => ({
  generation,
  request: {
    id,
    source: { type: 'crash', mechanism: 'uncaught' },
    report: {
      id,
      type: 'crash',
      severity: 'blocker',
      labels: [],
      attributes: {},
      signatures: ['sig'],
    },
  },
  attributes: { plan: 'pro', seats: 3, beta: true, tags: ['a', 'b'] },
  userIdentifier: 'user@example.com',
});

describe('createNodeReportMarkerStore', () => {
  it('creates the directory on construction', () => {
    const dir = join(root, 'nested', 'incidents');
    createNodeReportMarkerStore(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it('put then list round-trips a marker (keyed by request.id), with attributes + user preserved', () => {
    const store = createNodeReportMarkerStore(root);
    const m = marker('inc-1');
    store.put(m);
    expect(store.list()).toEqual([m]);
  });

  it('keys by request.id so distinct markers coexist; remove drops only the named one', () => {
    const store = createNodeReportMarkerStore(root);
    store.put(marker('a'));
    store.put(marker('b'));
    // Both coexist on disk (distinct files keyed by request.id, not one shared file).
    expect(
      store
        .list()
        .map((m) => m.request.id)
        .sort(),
    ).toEqual(['a', 'b']);
    store.remove('a');
    store.remove('missing'); // no-op
    expect(store.list().map((m) => m.request.id)).toEqual(['b']);
  });

  it('replaces the marker for the same report id', () => {
    const store = createNodeReportMarkerStore(root);
    store.put(marker('a', 1));
    store.put(marker('a', 2)); // same id, newer generation
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.generation).toBe(2);
  });

  it('durably persists across a reopen (a new store instance over the same dir)', () => {
    createNodeReportMarkerStore(root).put(marker('x'));
    // A fresh store over the same directory simulates a relaunch.
    expect(
      createNodeReportMarkerStore(root)
        .list()
        .map((m) => m.request.id),
    ).toEqual(['x']);
  });

  it('skips + purges a corrupt marker file and routes the parse error to onError', () => {
    const onError = vi.fn();
    const store = createNodeReportMarkerStore(root, onError);
    store.put(marker('good'));
    writeFileSync(join(root, 'corrupt.marker'), 'not-json'); // a torn/corrupt marker
    writeFileSync(join(root, 'ignore.txt'), 'unrelated'); // not a marker file
    const listed = store.list();
    expect(listed.map((m) => m.request.id)).toEqual(['good']); // corrupt skipped
    expect(onError).toHaveBeenCalledTimes(1);
    expect(() => statSync(join(root, 'corrupt.marker'))).toThrow(); // purged
    expect(statSync(join(root, 'ignore.txt')).isFile()).toBe(true); // foreign file untouched
  });

  it('defaults onError to a no-op (a corrupt marker is silently skipped + purged)', () => {
    const store = createNodeReportMarkerStore(root); // no onError
    writeFileSync(join(root, 'corrupt.marker'), '{bad');
    expect(() => store.list()).not.toThrow();
    expect(store.list()).toEqual([]);
  });
});
