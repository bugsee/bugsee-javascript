import { describe, expect, it, vi } from 'vitest';
import {
  type CrashReporterLike,
  type CrashReporterStartOptions,
  getCrashDumpsDirectory,
  installNativeCrashReporter,
} from './crash-reporter';

function fakeCrashReporter(over: Partial<CrashReporterLike> = {}) {
  const starts: CrashReporterStartOptions[] = [];
  return {
    crashReporter: {
      start: vi.fn((o: CrashReporterStartOptions) => starts.push(o)),
      ...over,
    } as CrashReporterLike,
    starts,
  };
}

const base = { appToken: 'tok', sessionId: 'sess-1' };

describe('installNativeCrashReporter', () => {
  it('starts Crashpad in HARVEST mode (uploadToServer:false) with the session-correlation extra', () => {
    const c = fakeCrashReporter();
    installNativeCrashReporter({ crashReporter: c.crashReporter, ...base });
    expect(c.starts[0]).toMatchObject({
      uploadToServer: false, // Bugsee harvests + bundles the dump; Crashpad never uploads
      extra: { session_id: 'sess-1', app_token: 'tok' },
    });
    expect('submitURL' in (c.starts[0] ?? {})).toBe(false); // no direct-upload endpoint
  });

  it('merges caller extra UNDER the correlation params (session/app win, never overridable)', () => {
    const c = fakeCrashReporter();
    installNativeCrashReporter({
      crashReporter: c.crashReporter,
      ...base,
      extra: { app_version: '1.2.3', session_id: 'HACK' },
    });
    expect(c.starts[0]?.extra).toEqual({
      app_version: '1.2.3',
      session_id: 'sess-1', // caller cannot override the correlation
      app_token: 'tok',
    });
  });

  it('passes through startOptions (companyName/compress/…)', () => {
    const c = fakeCrashReporter();
    installNativeCrashReporter({
      crashReporter: c.crashReporter,
      ...base,
      startOptions: { compress: true } as never,
    });
    expect(c.starts[0]?.compress).toBe(true);
    expect(c.starts[0]?.uploadToServer).toBe(false); // startOptions can't flip harvest mode
  });
});

describe('getCrashDumpsDirectory', () => {
  it('returns the crashReporter crash-dumps directory when available', () => {
    const c = fakeCrashReporter({ getCrashesDirectory: () => '/tmp/crashpad' });
    expect(getCrashDumpsDirectory(c.crashReporter)).toBe('/tmp/crashpad');
  });

  it('returns undefined when the crashReporter has no getCrashesDirectory', () => {
    const c = fakeCrashReporter();
    expect(getCrashDumpsDirectory(c.crashReporter)).toBeUndefined();
  });
});
