import { describe, expect, it } from 'vitest';
import {
  APP_TOKEN_FILENAME,
  BUNDLE_FILE_SUFFIX,
  DEFAULT_FILENAMES,
  MANIFEST_JSON_FILENAME,
  MANIFEST_VERSION,
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
});
