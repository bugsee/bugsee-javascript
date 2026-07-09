import { describe, expect, it, vi } from 'vitest';
import { resolvePluginOptions, runPluginUpload } from './resolve';

describe('resolvePluginOptions', () => {
  it('uses explicit options, preferring them over env vars', () => {
    const r = resolvePluginOptions(
      { appToken: 'opt-tok', appVersion: '2.0.0', appBuild: '9', endpoint: 'https://opt.test' },
      { BUGSEE_APP_TOKEN: 'env-tok', BUGSEE_ENDPOINT: 'https://env.test' },
    );
    expect(r.appToken).toBe('opt-tok');
    expect(r.appVersion).toBe('2.0.0');
    expect(r.appBuild).toBe('9');
    expect(r.endpoint).toBe('https://opt.test');
    expect(r.enabled).toBe(true);
  });

  it('falls back to env vars (token/endpoint/version/build)', () => {
    const r = resolvePluginOptions(
      {},
      {
        BUGSEE_APP_TOKEN: 'env-tok',
        BUGSEE_ENDPOINT: 'https://env.test',
        BUGSEE_APP_VERSION: '3.1.0',
        BUGSEE_APP_BUILD: '55',
      },
    );
    expect(r.appToken).toBe('env-tok');
    expect(r.endpoint).toBe('https://env.test');
    expect(r.appVersion).toBe('3.1.0');
    expect(r.appBuild).toBe('55');
    expect(r.enabled).toBe(true);
  });

  it('applies defaults (version 0.0.0, build 0, deleteMaps true, dryRun false)', () => {
    const r = resolvePluginOptions({ appToken: 't' }, {});
    expect(r.appVersion).toBe('0.0.0');
    expect(r.appBuild).toBe('0');
    expect(r.deleteMaps).toBe(true);
    expect(r.dryRun).toBe(false);
    expect(r.endpoint).toBeUndefined();
  });

  it('is disabled (enabled=false) when there is no app token', () => {
    expect(resolvePluginOptions({}, {}).enabled).toBe(false);
  });

  it('is disabled when `disabled: true`, even with a token', () => {
    expect(resolvePluginOptions({ appToken: 't', disabled: true }, {}).enabled).toBe(false);
  });

  it('respects explicit deleteMaps:false / dryRun:true', () => {
    const r = resolvePluginOptions({ appToken: 't', deleteMaps: false, dryRun: true }, {});
    expect(r.deleteMaps).toBe(false);
    expect(r.dryRun).toBe(true);
  });
});

describe('runPluginUpload', () => {
  it('calls uploadSourcemaps with the resolved context when enabled', async () => {
    const uploadSourcemaps = vi.fn(async () => ({
      injected: true,
      uploaded: true,
      deletedMaps: [],
    }));
    const resolved = resolvePluginOptions(
      {
        appToken: 't',
        appVersion: '1.0.0',
        appBuild: '4',
        endpoint: 'https://e.test',
        deleteMaps: false,
      },
      {},
    );
    await runPluginUpload(resolved, '/out', { uploadSourcemaps });
    expect(uploadSourcemaps).toHaveBeenCalledWith({
      outDir: '/out',
      appToken: 't',
      appVersion: '1.0.0',
      appBuild: '4',
      endpoint: 'https://e.test',
      deleteMaps: false,
      dryRun: false,
    });
  });

  it('does NOT call uploadSourcemaps when disabled', async () => {
    const uploadSourcemaps = vi.fn(async () => ({
      injected: true,
      uploaded: true,
      deletedMaps: [],
    }));
    const resolved = resolvePluginOptions({}, {}); // no token → disabled
    await runPluginUpload(resolved, '/out', { uploadSourcemaps });
    expect(uploadSourcemaps).not.toHaveBeenCalled();
  });
});
