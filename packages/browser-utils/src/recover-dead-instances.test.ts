import { type Bundle, serializeBundle, type UploadPipeline } from '@bugsee/core';
import { Severity } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { AsyncBlobStore } from './idb';
import { recoverSiblingBundleQueue } from './recover-dead-instances';

const aBundle = (summary: string): Bundle => ({
  request: {
    type: 'crash',
    summary,
    severity: Severity.Blocker,
    source: { type: 'crash', mechanism: 'uncaught' },
    created_on: '2026-06-29T00:00:00Z',
    environment: {
      platform: { type: 'web', version: '1' },
      runtime: { type: 'web', version: '' },
      sdk: { version: '0', type: 'javascript' },
    },
  },
  body: new Uint8Array([0x50, 0x4b, 1]),
  fileName: 'recovered.zip',
});

function memBlobWith(entries: Array<[string, Uint8Array]>) {
  const map = new Map(entries);
  const store: AsyncBlobStore = {
    loadAll: () => Promise.resolve([...map.entries()]),
    put: (id, b) => {
      map.set(id, b);
      return Promise.resolve();
    },
    remove: (id) => {
      map.delete(id);
      return Promise.resolve();
    },
  };
  return { store, map };
}

const okPipeline = (): UploadPipeline & { enqueue: ReturnType<typeof vi.fn> } => ({
  enqueue: vi.fn(() => Promise.resolve({ ok: true })),
  flush: vi.fn(() => Promise.resolve(true)),
  drop: vi.fn(),
});

describe('recoverSiblingBundleQueue', () => {
  it('re-uploads a dead instance bundle and removes it on confirmed delivery', async () => {
    const shared = memBlobWith([['dead/b1', serializeBundle(aBundle('a prior crash'))]]);
    const pipeline = okPipeline();
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline);
    expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
    expect((pipeline.enqueue.mock.calls[0]?.[0] as Bundle).request.summary).toBe('a prior crash');
    expect(shared.map.has('dead/b1')).toBe(false); // delivered → durable copy dropped
  });

  // A collector REFUSAL is settled, exactly as the live durable pipeline treats it. Gating on `ok` alone
  // re-uploads a 4xx-rejected bundle at every launch forever, and this tier has no retention sweep at all
  // to bound it (node's `sweep-instances` at least caps it at 7 days).
  it('drops a PERMANENTLY refused bundle instead of re-uploading it every launch', async () => {
    const shared = memBlobWith([['dead/b1', serializeBundle(aBundle('refused'))]]);
    const pipeline: UploadPipeline = {
      enqueue: () => Promise.resolve({ ok: false, permanent: true }),
      flush: () => Promise.resolve(true),
      drop: () => {},
    };
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline);
    expect(shared.map.has('dead/b1')).toBe(false);
  });

  it('keeps the bundle when delivery is NOT confirmed (retry next launch)', async () => {
    const shared = memBlobWith([['dead/b1', serializeBundle(aBundle('x'))]]);
    const pipeline: UploadPipeline = {
      enqueue: () => Promise.resolve({ ok: false }),
      flush: () => Promise.resolve(true),
      drop: () => {},
    };
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline);
    expect(shared.map.has('dead/b1')).toBe(true); // not delivered → kept
  });

  it('purges an unparseable leftover (onError) and survives an enqueue throw', async () => {
    const onError = vi.fn();
    const shared = memBlobWith([
      ['dead/bad', new Uint8Array([1, 2, 3])], // not a serialized bundle
      ['dead/throws', serializeBundle(aBundle('y'))],
    ]);
    const pipeline: UploadPipeline = {
      enqueue: () => Promise.reject(new Error('net down')),
      flush: () => Promise.resolve(true),
      drop: () => {},
    };
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline, onError);
    expect(shared.map.has('dead/bad')).toBe(false); // unparseable → purged
    expect(shared.map.has('dead/throws')).toBe(true); // enqueue threw → kept for retry
    expect(onError).toHaveBeenCalledTimes(2); // the parse error + the enqueue throw
  });

  it('only touches the named instance prefix (never another instance bundle)', async () => {
    const shared = memBlobWith([
      ['dead/b1', serializeBundle(aBundle('dead'))],
      ['other/b2', serializeBundle(aBundle('other'))],
    ]);
    await recoverSiblingBundleQueue(shared.store, 'dead', okPipeline());
    expect(shared.map.has('dead/b1')).toBe(false); // recovered
    expect(shared.map.has('other/b2')).toBe(true); // untouched
  });

  it('swallows an unparseable leftover with the default no-op onError (no onError arg, never throws)', async () => {
    const shared = memBlobWith([['dead/bad', new Uint8Array([9, 9, 9])]]);
    await expect(
      recoverSiblingBundleQueue(shared.store, 'dead', okPipeline()),
    ).resolves.toBeUndefined();
    expect(shared.map.has('dead/bad')).toBe(false); // still purged under the default onError
  });

  it('routes a loadAll failure to onError and recovers nothing (never throws)', async () => {
    const onError = vi.fn();
    const shared: AsyncBlobStore = {
      loadAll: () => Promise.reject(new Error('idb gone')),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const pipeline = okPipeline();
    await expect(
      recoverSiblingBundleQueue(shared, 'dead', pipeline, onError),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(pipeline.enqueue).not.toHaveBeenCalled();
  });
});
