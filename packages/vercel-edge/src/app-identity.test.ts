import { afterEach, describe, expect, it, vi } from 'vitest';
import { edgeAppIdentity } from './app-identity';

afterEach(() => vi.unstubAllEnvs());

describe('edgeAppIdentity', () => {
  it('reads BUGSEE_APP_VERSION / BUGSEE_APP_BUILD, trimmed', () => {
    vi.stubEnv('BUGSEE_APP_VERSION', ' 3.1.0\n');
    vi.stubEnv('BUGSEE_APP_BUILD', '\t77 ');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'sha');
    expect(edgeAppIdentity()).toEqual({ version: '3.1.0', build: '77' });
  });

  it('falls back to the trimmed Vercel commit for the build only', () => {
    vi.stubEnv('BUGSEE_APP_VERSION', '  ');
    vi.stubEnv('BUGSEE_APP_BUILD', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', ' cafe\n');
    expect(edgeAppIdentity()).toEqual({ build: 'cafe' });
  });

  it('is empty when nothing is set', () => {
    vi.stubEnv('BUGSEE_APP_VERSION', '');
    vi.stubEnv('BUGSEE_APP_BUILD', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    expect(edgeAppIdentity()).toEqual({});
  });
});
