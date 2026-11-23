import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEdgeAppIdentity, edgeAppIdentity } from './app-identity';

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

describe('createEdgeAppIdentity bindings (Cloudflare env)', () => {
  it('reads BUGSEE_APP_VERSION / BUGSEE_APP_BUILD from the bindings, trimmed', () => {
    vi.stubEnv('BUGSEE_APP_VERSION', '');
    vi.stubEnv('BUGSEE_APP_BUILD', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    expect(
      createEdgeAppIdentity({ BUGSEE_APP_VERSION: ' 2.0.0\n', BUGSEE_APP_BUILD: ' 12 ' })(),
    ).toEqual({ version: '2.0.0', build: '12' });
  });

  it('takes the version tag and id from a CF_VERSION_METADATA binding', () => {
    vi.stubEnv('BUGSEE_APP_VERSION', '');
    vi.stubEnv('BUGSEE_APP_BUILD', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    expect(
      createEdgeAppIdentity({ CF_VERSION_METADATA: { id: ' abc-123 ', tag: ' v7 ' } })(),
    ).toEqual({ version: 'v7', build: 'abc-123' });
  });

  it('ignores blank/odd metadata fields and a non-object binding', () => {
    vi.stubEnv('BUGSEE_APP_VERSION', '');
    vi.stubEnv('BUGSEE_APP_BUILD', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    expect(createEdgeAppIdentity({ CF_VERSION_METADATA: { id: ' ', tag: 5 } })()).toEqual({});
    expect(createEdgeAppIdentity({ CF_VERSION_METADATA: 'x' })()).toEqual({});
    expect(createEdgeAppIdentity({ BUGSEE_APP_VERSION: 7 })()).toEqual({});
  });

  it('process.env wins over bindings, which fill what it lacks', () => {
    vi.stubEnv('BUGSEE_APP_VERSION', '1.0.0');
    vi.stubEnv('BUGSEE_APP_BUILD', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    expect(
      createEdgeAppIdentity({
        BUGSEE_APP_VERSION: '9.9.9',
        CF_VERSION_METADATA: { id: 'vid', tag: 't' },
      })(),
    ).toEqual({ version: '1.0.0', build: 'vid' });
  });

  it('explicit BUGSEE_APP_VERSION binding beats the metadata tag', () => {
    vi.stubEnv('BUGSEE_APP_VERSION', '');
    vi.stubEnv('BUGSEE_APP_BUILD', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
    expect(
      createEdgeAppIdentity({
        BUGSEE_APP_VERSION: '3.0.0',
        BUGSEE_APP_BUILD: 'b',
        CF_VERSION_METADATA: { id: 'vid', tag: 't' },
      })(),
    ).toEqual({ version: '3.0.0', build: 'b' });
  });

  it('without bindings it equals edgeAppIdentity', () => {
    vi.stubEnv('BUGSEE_APP_VERSION', '4.0.0');
    expect(createEdgeAppIdentity()()).toEqual(edgeAppIdentity());
  });
});
