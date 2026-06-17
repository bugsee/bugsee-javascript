import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DATA_SUBDIR, resolveDataLocation } from './data-location';

describe('resolveDataLocation', () => {
  it('defaults to disk capture under <tmpBase>/bugsee when neither flag is set (opt-out, not opt-in)', () => {
    expect(resolveDataLocation({}, '/tmp')).toEqual({
      dataDir: join('/tmp', DEFAULT_DATA_SUBDIR),
      diskCapture: true,
    });
  });

  it("capturedDataStore: 'disk' (explicit) also resolves the tmp default + disk capture", () => {
    expect(resolveDataLocation({ capturedDataStore: 'disk' }, '/tmp')).toEqual({
      dataDir: join('/tmp', DEFAULT_DATA_SUBDIR),
      diskCapture: true,
    });
  });

  it("capturedDataStore: 'memory' opts fully out — no dataDir, no disk capture", () => {
    expect(resolveDataLocation({ capturedDataStore: 'memory' }, '/tmp')).toEqual({
      dataDir: undefined,
      diskCapture: false,
    });
  });

  it('an explicit dataDir overrides the tmp default (disk capture stays on by default)', () => {
    expect(resolveDataLocation({ dataDir: '/var/data' }, '/tmp')).toEqual({
      dataDir: '/var/data',
      diskCapture: true,
    });
  });

  it("dataDir + capturedDataStore: 'memory' keeps the location (durable bundles) but capture stays in-memory", () => {
    // The odd-but-valid combo: persist bundles/markers under dataDir, but keep the rolling capture buffer
    // in RAM. The explicit memory choice wins for capture; the location still locates durable storage.
    expect(
      resolveDataLocation({ dataDir: '/var/data', capturedDataStore: 'memory' }, '/tmp'),
    ).toEqual({ dataDir: '/var/data', diskCapture: false });
  });

  it('uses the provided tmpBase verbatim for the default root', () => {
    expect(resolveDataLocation({}, '/custom/tmp').dataDir).toBe(
      join('/custom/tmp', DEFAULT_DATA_SUBDIR),
    );
  });
});
