import { describe, expect, it, vi } from 'vitest';
import type { UploadSourcemapsOptions, UploadSourcemapsResult } from './orchestrate';
import { resolvePluginOptions, runPluginUpload } from './resolve';
import type { ResolveVcsMetadataOptions, VcsMetadata } from './vcs';

/**
 * Every `runPluginUpload` below injects this. Without it the real `resolveVcsMetadata` runs, which forks
 * `bugsee-cli vcs-metadata` — a real subprocess, and a test that depends on the machine's own git state.
 */
const noVcs = { resolveVcs: async (): Promise<undefined> => undefined };

/** VCS collection precedes the upload, so the upload starts a tick later than the call. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

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
    await runPluginUpload(resolved, '/out', { uploadSourcemaps, ...noVcs });
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
    await runPluginUpload(resolved, '/out', { uploadSourcemaps, ...noVcs });
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
      { uploadSourcemaps: uploadSourcemaps as never, ...noVcs },
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
    const a = runPluginUpload(resolved, 'dist', {
      uploadSourcemaps: h.uploadSourcemaps as never,
      ...noVcs,
    });
    const b = runPluginUpload(resolved, 'dist', {
      uploadSourcemaps: h.uploadSourcemaps as never,
      ...noVcs,
    });
    await tick();
    expect(h.started).toEqual(['dist']);
    h.release();
    expect(await a).toEqual(await b); // …and the joiner gets the same result, not `undefined`
  });

  it('still runs a second pipeline for a DIFFERENT directory — the canary', async () => {
    const h = held();
    const a = runPluginUpload(resolved, 'dist-a', {
      uploadSourcemaps: h.uploadSourcemaps as never,
      ...noVcs,
    });
    const b = runPluginUpload(resolved, 'dist-b', {
      uploadSourcemaps: h.uploadSourcemaps as never,
      ...noVcs,
    });
    await tick();
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
      ...noVcs,
    });
    h.release();
    await first;
    await runPluginUpload(resolved, 'dist-w', {
      uploadSourcemaps: h.uploadSourcemaps as never,
      ...noVcs,
    });
    expect(h.started).toEqual(['dist-w', 'dist-w']);
  });

  it('releases the slot even when the run FAILS', async () => {
    // A guard that leaks its entry on failure would block every later build of that directory.
    const failing = async () => {
      throw new Error('boom');
    };
    await expect(
      runPluginUpload(resolved, 'dist-f', { uploadSourcemaps: failing as never, ...noVcs }),
    ).rejects.toThrow();
    const ok = vi.fn(async () => ({ injected: true, uploaded: true, deletedMaps: [] }));
    await runPluginUpload(resolved, 'dist-f', { uploadSourcemaps: ok as never, ...noVcs });
    expect(ok).toHaveBeenCalled();
  });
});

// ── SM-A4: build VCS metadata (the commit SHA) ────────────────────────────────────────────────────
// Why this lives on the plugin at all: when an uploaded source map carries no `sourcesContent`, the
// backend's only remaining way to show a frame's original source is to fetch it from the customer's
// connected repository — which needs the commit the build was made from. Nothing captured it before.

describe('resolvePluginOptions — VCS options', () => {
  it('resolves VCS metadata by default', () => {
    expect(resolvePluginOptions({ appToken: 't' }, {}).vcs).toBe(true);
  });

  it('can be turned off with `vcs: false`', () => {
    expect(resolvePluginOptions({ appToken: 't', vcs: false }, {}).vcs).toBe(false);
  });

  it('takes an explicit commit override, else BUGSEE_BUILD_COMMIT, else undefined', () => {
    const sha = 'a'.repeat(40);
    expect(resolvePluginOptions({ appToken: 't', commit: sha }, {}).commit).toBe(sha);
    expect(resolvePluginOptions({ appToken: 't' }, { BUGSEE_BUILD_COMMIT: sha }).commit).toBe(sha);
    expect(
      resolvePluginOptions({ appToken: 't', commit: sha }, { BUGSEE_BUILD_COMMIT: 'b'.repeat(40) })
        .commit,
    ).toBe(sha);
    expect(resolvePluginOptions({ appToken: 't' }, {}).commit).toBeUndefined();
  });

  it('does NOT report a commit from a dirty tree unless asked', () => {
    expect(resolvePluginOptions({ appToken: 't' }, {}).allowDirtyCommit).toBe(false);
    expect(
      resolvePluginOptions({ appToken: 't', allowDirtyCommit: true }, {}).allowDirtyCommit,
    ).toBe(true);
  });

  it('defaults the project root to the build’s working directory', () => {
    expect(resolvePluginOptions({ appToken: 't' }, {}).projectRoot).toBe(process.cwd());
    expect(resolvePluginOptions({ appToken: 't', projectRoot: '/repo' }, {}).projectRoot).toBe(
      '/repo',
    );
  });
});

describe('runPluginUpload — VCS metadata collection', () => {
  const sha = 'a'.repeat(40);

  it('resolves the VCS metadata and hands it to uploadSourcemaps', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: true,
        deletedMaps: [],
      }),
    );
    const resolveVcs = vi.fn(
      async (_o: ResolveVcsMetadataOptions): Promise<VcsMetadata | undefined> => ({
        commit_sha: sha,
        branch: 'main',
      }),
    );
    const resolved = resolvePluginOptions(
      { appToken: 't', projectRoot: '/repo', commit: sha, allowDirtyCommit: true },
      {},
    );
    await runPluginUpload(resolved, '/out-vcs-1', { uploadSourcemaps, resolveVcs });

    expect(resolveVcs).toHaveBeenCalledWith({
      projectRoot: '/repo',
      enabled: true,
      commit: sha,
      allowDirtyCommit: true,
    });
    expect(uploadSourcemaps.mock.calls[0]?.[0]).toMatchObject({
      vcs: { commit_sha: sha, branch: 'main' },
    });
  });

  it('OMITS the vcs key entirely when nothing was resolved, rather than sending an empty object', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: true,
        deletedMaps: [],
      }),
    );
    const resolveVcs = vi.fn(
      async (_o: ResolveVcsMetadataOptions): Promise<VcsMetadata | undefined> => undefined,
    );
    const resolved = resolvePluginOptions({ appToken: 't' }, {});
    await runPluginUpload(resolved, '/out-vcs-2', { uploadSourcemaps, resolveVcs });
    expect(uploadSourcemaps.mock.calls[0]?.[0]).not.toHaveProperty('vcs');
  });

  it('passes `enabled: false` through when the plugin user turned VCS off', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: true,
        deletedMaps: [],
      }),
    );
    const resolveVcs = vi.fn(
      async (_o: ResolveVcsMetadataOptions): Promise<VcsMetadata | undefined> => undefined,
    );
    const resolved = resolvePluginOptions({ appToken: 't', vcs: false }, {});
    await runPluginUpload(resolved, '/out-vcs-3', { uploadSourcemaps, resolveVcs });
    expect(resolveVcs.mock.calls[0]?.[0]).toMatchObject({ enabled: false });
  });

  it('never lets a VCS failure break the upload — the maps still ship', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: true,
        deletedMaps: [],
      }),
    );
    const resolveVcs = vi.fn(
      async (_o: ResolveVcsMetadataOptions): Promise<VcsMetadata | undefined> => {
        throw new Error('resolver blew up');
      },
    );
    const resolved = resolvePluginOptions({ appToken: 't' }, {});
    const result = await runPluginUpload(resolved, '/out-vcs-4', { uploadSourcemaps, resolveVcs });
    expect(result?.uploaded).toBe(true);
    expect(uploadSourcemaps).toHaveBeenCalledTimes(1);
    expect(uploadSourcemaps.mock.calls[0]?.[0]).not.toHaveProperty('vcs');
  });
});

describe('runPluginUpload — the real VCS resolver is the default', () => {
  it('uses resolveVcsMetadata when no seam is injected (here with VCS off, so it forks nothing)', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: true,
        deletedMaps: [],
      }),
    );
    // `vcs: false` short-circuits inside the REAL resolver, so this asserts the default wiring without
    // spawning a subprocess or depending on this machine's git state.
    const resolved = resolvePluginOptions({ appToken: 't', vcs: false }, {});
    await runPluginUpload(resolved, '/out-vcs-default', { uploadSourcemaps });
    expect(uploadSourcemaps).toHaveBeenCalledTimes(1);
    expect(uploadSourcemaps.mock.calls[0]?.[0]).not.toHaveProperty('vcs');
  });
});
