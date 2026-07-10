import { describe, expect, it, vi } from 'vitest';
import {
  type CrashReporterStartOptions,
  deriveMinidumpUrl,
  installNativeCrashReporter,
} from './crash-reporter';

function fakeCrashReporter() {
  const starts: CrashReporterStartOptions[] = [];
  return { crashReporter: { start: vi.fn((o: CrashReporterStartOptions) => starts.push(o)) }, starts };
}

const base = { appToken: 'tok', sessionId: 'sess-1', submitURL: 'https://api.test/minidumps' };

describe('installNativeCrashReporter', () => {
  it('starts Crashpad with the submit URL, auto-upload, and session-correlation extra', () => {
    const c = fakeCrashReporter();
    installNativeCrashReporter({ crashReporter: c.crashReporter, ...base });
    expect(c.starts[0]).toMatchObject({
      submitURL: 'https://api.test/minidumps',
      uploadToServer: true,
      extra: { session_id: 'sess-1', app_token: 'tok' },
    });
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

  it('honours uploadToServer:false and passes through startOptions', () => {
    const c = fakeCrashReporter();
    installNativeCrashReporter({
      crashReporter: c.crashReporter,
      ...base,
      uploadToServer: false,
      startOptions: { compress: true } as never,
    });
    expect(c.starts[0]?.uploadToServer).toBe(false);
    expect(c.starts[0]?.compress).toBe(true);
  });
});

describe('deriveMinidumpUrl', () => {
  it('builds the Android-parity /v2/apps/{token}/minidumps URL, trimming a trailing slash', () => {
    expect(deriveMinidumpUrl('https://api.bugsee.com', 'abc')).toBe(
      'https://api.bugsee.com/v2/apps/abc/minidumps',
    );
    expect(deriveMinidumpUrl('https://api.bugsee.com/', 'abc')).toBe(
      'https://api.bugsee.com/v2/apps/abc/minidumps',
    );
  });
});
