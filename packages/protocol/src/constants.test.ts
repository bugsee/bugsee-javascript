import { describe, expect, it } from 'vitest';
import {
  APP_TOKEN_FILENAME,
  BUNDLE_FILE_SUFFIX,
  DEFAULT_FILENAMES,
  MANIFEST_JSON_FILENAME,
  MANIFEST_VERSION,
  NAME_SOURCE_ATTRIBUTE,
  REQUEST_JSON_FILENAME,
} from './index';

describe('wire constants', () => {
  it('manifest schema version is 2 (JS SDK)', () => {
    expect(MANIFEST_VERSION).toBe(2);
  });

  it('root bundle file names match the wire contract', () => {
    expect(REQUEST_JSON_FILENAME).toBe('request.json');
    expect(MANIFEST_JSON_FILENAME).toBe('manifest.json');
    expect(APP_TOKEN_FILENAME).toBe('apptoken');
    expect(BUNDLE_FILE_SUFFIX).toBe('.bundle.zip');
  });

  it('breadcrumbs default filename has NO .json extension (mobile contract)', () => {
    expect(DEFAULT_FILENAMES.breadcrumbs).toBe('breadcrumbs');
  });

  it('replay default filename is the gzipped rrweb stream', () => {
    expect(DEFAULT_FILENAMES.replay).toBe('replay.bin');
  });

  it('json-typed files carry the right filenames', () => {
    expect(DEFAULT_FILENAMES.network).toBe('network.json');
    expect(DEFAULT_FILENAMES.log).toBe('logs.json');
    expect(DEFAULT_FILENAMES['log.internal']).toBe('internal.logs.json');
    expect(DEFAULT_FILENAMES['events.user']).toBe('events.user.json');
    expect(DEFAULT_FILENAMES['traces.system']).toBe('traces.system.json');
    expect(DEFAULT_FILENAMES.performance).toBe('performance.json');
    expect(DEFAULT_FILENAMES.profile).toBe('profile.json'); // V8 CPU profile (node diagnostics)
  });

  it('video default filename is the encoded pixel-capture stream (Electron)', () => {
    expect(DEFAULT_FILENAMES.video).toBe('video.webm');
  });

  // The DEDICATED input stream (mobile-canonical `<random>.input.json`). It exists so SDK-captured
  // device input never has to be written into `events.user`, which is reserved for app-supplied
  // `client.event()` data.
  it('input default filename is the mobile-canonical input stream', () => {
    expect(DEFAULT_FILENAMES.input).toBe('input.json');
  });

  it('input is a distinct stream from events.user (they never share a file name)', () => {
    expect(DEFAULT_FILENAMES.input).not.toBe(DEFAULT_FILENAMES['events.user']);
  });

  // The geometry sidecar that gives `input`'s coordinates a frame to be drawn against
  // (specs sdk/reporting/bundle/video-aux.md). Mobile-canonical name: the viewer's manifest
  // reader switches on the TYPE `video.aux`, so the type string is the contract.
  it('video.aux default filename is the geometry sidecar', () => {
    expect(DEFAULT_FILENAMES['video.aux']).toBe('video.aux.json');
  });

  it('video.aux is a sidecar, not the video itself (separate files)', () => {
    expect(DEFAULT_FILENAMES['video.aux']).not.toBe(DEFAULT_FILENAMES.video);
  });

  // R2-8: the transaction-naming-provenance wire attribute lives here (not in @bugsee/performance) so
  // @bugsee/node can read it off a Transaction without a runtime dependency on the opt-in APM extension.
  it('the transaction name-source attribute is the wire key @bugsee/performance stamps', () => {
    expect(NAME_SOURCE_ATTRIBUTE).toBe('bugsee.name_source');
  });
});
