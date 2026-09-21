import {
  type CaptureProviderInit,
  type CaptureStore,
  createCaptureAggregator,
  createCaptureExporter,
  createMemoryCaptureStore,
  createMultiKeyEmitter,
  createOperationDispatcher,
  createOptionsContainer,
  type MultiKeyEmitter,
  type OptionsContainer,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { createVideoAuxProvider, type VideoAuxEventDetail } from './video-aux-provider';

const mkStore = (): CaptureStore =>
  createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
const buildInit = (store: CaptureStore): CaptureProviderInit => ({
  operations: createOperationDispatcher(),
  captureAggregator: createCaptureAggregator(store),
});
const options: OptionsContainer = createOptionsContainer();
const mkSource = (): MultiKeyEmitter<{ viewport: VideoAuxEventDetail }> => createMultiKeyEmitter();
const drainAux = async (store: CaptureStore) =>
  (await createCaptureExporter(store).drain()).get('video.aux');

const GEOMETRY = { frameW: 1280, frameH: 720, density: 2 };

describe('createVideoAuxProvider', () => {
  it('is named "video.aux" and gated by captureInteractions', () => {
    // Gated with `input`, deliberately: the stream exists to give `input`'s coordinates a frame, so
    // a build that captures no interactions has no consumer for the geometry.
    const p = createVideoAuxProvider(mkSource());
    expect(p.name).toBe('video.aux');
    expect(p.controllingOption).toBe(BugseeOption.CaptureInteractions);
  });

  it('captures a source event as a `video.aux` entry, stamped from the clock', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createVideoAuxProvider(source, { now: () => 1000 });
    p.init(buildInit(store));
    p.start(options);

    source.emit('viewport', GEOMETRY);

    const entries = await drainAux(store);
    expect(entries?.map((e) => e.data)).toStrictEqual([{ timestamp: 1000, ...GEOMETRY }]);
    expect(entries?.[0]?.timestamp).toBe(1000);
  });

  it('keeps a timestamp the source already knows', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createVideoAuxProvider(source, { now: () => 1000 });
    p.init(buildInit(store));
    p.start(options);

    source.emit('viewport', { ...GEOMETRY, timestamp: 42 });

    const entries = await drainAux(store);
    expect(entries?.map((e) => e.data)).toStrictEqual([{ timestamp: 42, ...GEOMETRY }]);
    expect(entries?.[0]?.timestamp).toBe(42);
  });

  it('stamps an explicitly undefined timestamp rather than writing it through', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createVideoAuxProvider(source, { now: () => 7 });
    p.init(buildInit(store));
    p.start(options);

    source.emit('viewport', { ...GEOMETRY, timestamp: undefined });

    const entries = await drainAux(store);
    // An entry with no timestamp would place every coordinate against nothing.
    expect(entries?.map((e) => e.data)).toStrictEqual([{ timestamp: 7, ...GEOMETRY }]);
  });

  it('passes the pinch fields through untouched', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createVideoAuxProvider(source, { now: () => 1 });
    p.init(buildInit(store));
    p.start(options);

    source.emit('viewport', {
      ...GEOMETRY,
      scale: 2.5,
      offsetX: 240,
      offsetY: 100,
      visibleW: 512,
      visibleH: 288,
    });

    const entries = await drainAux(store);
    expect(entries?.[0]?.data).toStrictEqual({
      timestamp: 1,
      ...GEOMETRY,
      scale: 2.5,
      offsetX: 240,
      offsetY: 100,
      visibleW: 512,
      visibleH: 288,
    });
  });

  it('records nothing once stopped', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createVideoAuxProvider(source, { now: () => 1 });
    p.init(buildInit(store));
    p.start(options);
    p.stop();

    source.emit('viewport', GEOMETRY);

    expect(await drainAux(store)).toBeUndefined();
  });

  it('records again after a stop and a restart', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createVideoAuxProvider(source, { now: () => 1 });
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    p.start(options);

    source.emit('viewport', GEOMETRY);

    const entries = await drainAux(store);
    expect(entries?.length).toBe(1);
  });

  it('defaults its clock to wall time when none is injected', async () => {
    const store = mkStore();
    const source = mkSource();
    const before = Date.now();
    const p = createVideoAuxProvider(source);
    p.init(buildInit(store));
    p.start(options);

    source.emit('viewport', GEOMETRY);

    const entries = await drainAux(store);
    const stamped = (entries?.[0]?.data as { timestamp: number }).timestamp;
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });
});
