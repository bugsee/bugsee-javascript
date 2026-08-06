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
    // An EXACT match, deliberately: this is the whole contract handed to the orchestrator, and a field
    // silently dropped on the way through is exactly how `failOnError` would become inert.
    expect(uploadSourcemaps).toHaveBeenCalledWith({
      outDir: '/out',
      appToken: 't',
      appVersion: '1.0.0',
      appBuild: '4',
      endpoint: 'https://e.test',
      deleteMaps: false,
      dryRun: false,
      failOnError: false,
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

// WAVE 7 — the failure policy has to be reachable from the PUBLIC option bag.
//
// `failOnError` existing on the internal orchestrator is worth nothing if a user cannot set it: the whole
// point is that a team decides whether a source-map upload may break their deploy.
describe('failOnError / onError plumbing (Wave 7)', () => {
  it('defaults to NOT failing the build', () => {
    expect(resolvePluginOptions({ appToken: 'tok' }, {}).failOnError).toBe(false);
  });

  it('carries an explicit failOnError through', () => {
    expect(resolvePluginOptions({ appToken: 'tok', failOnError: true }, {}).failOnError).toBe(true);
  });

  it('hands both down to the orchestrator', async () => {
    const onError = vi.fn();
    const seen: Array<Record<string, unknown>> = [];
    const uploadSourcemaps = async (opts: Record<string, unknown>) => {
      seen.push(opts);
      return { injected: true, uploaded: true, deletedMaps: [] };
    };
    await runPluginUpload(
      resolvePluginOptions({ appToken: 'tok', failOnError: true, onError }, {}),
      'dist',
      { uploadSourcemaps: uploadSourcemaps as never },
    );
    expect(seen[0]).toMatchObject({ failOnError: true, onError });
  });
});

// WAVE 7.5 — two pipelines over one directory.
//
// `writeBundle` fires once per OUTPUT. A multi-output config whose entries resolve to the same directory —
// `output: [{ dir: 'dist' }, { file: 'dist/legacy.js' }]`, both `dist` — starts two concurrent pipelines
// over one tree: one can be deleting maps (step 3) while the other is still reading them (steps 1-2).
describe('one pipeline per output directory (Wave 7.5)', () => {
  /** An upload we can hold open, so overlap is observable rather than a race. */
  const held = () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const uploadSourcemaps = async (opts: { outDir: string }) => {
      started.push(opts.outDir);
      await gate;
      return { injected: true, uploaded: true, deletedMaps: [] };
    };
    return { started, release, uploadSourcemaps };
  };

  const resolved = resolvePluginOptions({ appToken: 'tok' }, {});

  it('joins a concurrent run for the SAME directory instead of starting a second', async () => {
    const h = held();
    const a = runPluginUpload(resolved, 'dist', { uploadSourcemaps: h.uploadSourcemaps as never });
    const b = runPluginUpload(resolved, 'dist', { uploadSourcemaps: h.uploadSourcemaps as never });
    expect(h.started).toEqual(['dist']);
    h.release();
    expect(await a).toEqual(await b); // …and the joiner gets the same result, not `undefined`
  });

  it('still runs a second pipeline for a DIFFERENT directory — the canary', async () => {
    const h = held();
    const a = runPluginUpload(resolved, 'dist-a', {
      uploadSourcemaps: h.uploadSourcemaps as never,
    });
    const b = runPluginUpload(resolved, 'dist-b', {
      uploadSourcemaps: h.uploadSourcemaps as never,
    });
    expect(h.started).toEqual(['dist-a', 'dist-b']);
    h.release();
    await Promise.all([a, b]);
  });

  it('runs again for the same directory on a LATER build (watch mode)', async () => {
    // Per-run, not permanent: `vite build --watch` legitimately rebuilds the same directory, and a
    // once-only guard would silently stop uploading after the first rebuild.
    const h = held();
    const first = runPluginUpload(resolved, 'dist-w', {
      uploadSourcemaps: h.uploadSourcemaps as never,
    });
    h.release();
    await first;
    await runPluginUpload(resolved, 'dist-w', { uploadSourcemaps: h.uploadSourcemaps as never });
    expect(h.started).toEqual(['dist-w', 'dist-w']);
  });

  it('releases the slot even when the run FAILS', async () => {
    // A guard that leaks its entry on failure would block every later build of that directory.
    const failing = async () => {
      throw new Error('boom');
    };
    await expect(
      runPluginUpload(resolved, 'dist-f', { uploadSourcemaps: failing as never }),
    ).rejects.toThrow();
    const ok = vi.fn(async () => ({ injected: true, uploaded: true, deletedMaps: [] }));
    await runPluginUpload(resolved, 'dist-f', { uploadSourcemaps: ok as never });
    expect(ok).toHaveBeenCalled();
  });
});
