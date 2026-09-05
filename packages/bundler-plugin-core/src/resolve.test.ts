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

  it('passes a MALFORMED commit through RAW — validation happens in exactly one place', () => {
    // resolve.ts documents this: `resolveCommitOverride` is the single validator, so adding a second
    // check here is the drift the comment forbids. Without this test that mutation survives.
    expect(resolvePluginOptions({ appToken: 't', commit: 'not-a-sha' }, {}).commit).toBe(
      'not-a-sha',
    );
    expect(resolvePluginOptions({ appToken: 't' }, { BUGSEE_BUILD_COMMIT: 'HEAD' }).commit).toBe(
      'HEAD',
    );
  });

  it('does NOT report a commit from a dirty tree unless asked', () => {
    expect(resolvePluginOptions({ appToken: 't' }, {}).allowDirtyCommit).toBe(false);
    expect(
      resolvePluginOptions({ appToken: 't', allowDirtyCommit: true }, {}).allowDirtyCommit,
    ).toBe(true);
  });

  it('keeps projectRoot UNRESOLVED when not given — it must not touch process.cwd() eagerly', () => {
    // `resolvePluginOptions` runs synchronously from `bugseeUnpluginFactory` at config-evaluation time,
    // OUTSIDE every containment layer — not in `runPluginUpload`, not in `uploadSourcemaps`, not gated
    // on `failOnError`. `process.cwd()` THROWS (ENOENT, uncwd) when the process's working directory has
    // been unlinked, which a build script that recreates its own directory really does. Calling it here
    // would fail the build from a plugin whose entire contract is that it cannot — and it would do so
    // even for a fully disabled plugin, since this field was computed before `enabled` is consulted.
    expect(resolvePluginOptions({ appToken: 't' }, {}).projectRoot).toBeUndefined();
    expect(resolvePluginOptions({ appToken: 't', projectRoot: '/repo' }, {}).projectRoot).toBe(
      '/repo',
    );
  });

  it('resolves projectRoot for a DISABLED plugin without touching the filesystem either', () => {
    expect(resolvePluginOptions({}, {}).projectRoot).toBeUndefined();
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
      // The env was ALREADY consulted at this layer, so the resolver must not reach for `process.env`
      // behind the seam — an ambient BUGSEE_BUILD_COMMIT would otherwise defeat an injected env.
      env: {},
      onNotice: expect.any(Function),
    });
    // The FULL bag, exactly — `toMatchObject` is recursively partial, so it would not notice a field
    // dropped on the way through, which is precisely how the plumbing breaks.
    expect(uploadSourcemaps.mock.calls[0]?.[0]).toEqual({
      outDir: '/out-vcs-1',
      appToken: 't',
      appVersion: '0.0.0',
      appBuild: '0',
      endpoint: undefined,
      deleteMaps: true,
      dryRun: false,
      failOnError: false,
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

  it('does not call the resolver AT ALL when the plugin user turned VCS off', async () => {
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
    // Short-circuited at this layer rather than inside the resolver, so a disabled feature resolves no
    // cwd, spawns nothing, and has no path on which it could fail.
    expect(resolveVcs).not.toHaveBeenCalled();
    expect(uploadSourcemaps.mock.calls[0]?.[0]).not.toHaveProperty('vcs');
  });

  it('defaults projectRoot to the cwd LAZILY, at collection time rather than construction time', async () => {
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
    await runPluginUpload(resolved, '/out-vcs-lazy', { uploadSourcemaps, resolveVcs });
    expect(resolveVcs.mock.calls[0]?.[0].projectRoot).toBe(process.cwd());
  });

  it('does NOT resolve the cwd at all when VCS is disabled', async () => {
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
    await runPluginUpload(resolved, '/out-vcs-off-cwd', { uploadSourcemaps, resolveVcs });
    expect(resolveVcs).not.toHaveBeenCalled();
  });

  it('collects independently per output directory — no shared cross-instance memo', async () => {
    // A per-root memo was tried and REMOVED. Bundlers call `writeBundle` sequentially (vite awaits each
    // `bundle.write`), so an in-flight memo never fired for the multi-output case it was added for,
    // while a module-level map shared across every plugin instance in the process meant a second
    // instance configured `allowDirtyCommit: false` could join a result collected WITH it — recording
    // a SHA for a dirty tree, the exact invariant this feature exists to protect.
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: true,
        deletedMaps: [],
      }),
    );
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const resolveVcs = async (_o: ResolveVcsMetadataOptions): Promise<VcsMetadata | undefined> => {
      calls += 1;
      await gate;
      return { commit_sha: sha };
    };
    const resolved = resolvePluginOptions({ appToken: 't', projectRoot: '/shared-root' }, {});
    const a = runPluginUpload(resolved, '/out-multi-a', { uploadSourcemaps, resolveVcs });
    const b = runPluginUpload(resolved, '/out-multi-b', { uploadSourcemaps, resolveVcs });
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(2);
    // …and BOTH outputs still get the metadata — dedupe must not mean "the second one loses it".
    expect(uploadSourcemaps.mock.calls[0]?.[0]).toMatchObject({ vcs: { commit_sha: sha } });
    expect(uploadSourcemaps.mock.calls[1]?.[0]).toMatchObject({ vcs: { commit_sha: sha } });
  });

  it('re-collects on a LATER build of the same root — a commit made mid-watch must be picked up', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: true,
        deletedMaps: [],
      }),
    );
    let calls = 0;
    const resolveVcs = async (_o: ResolveVcsMetadataOptions): Promise<VcsMetadata | undefined> => {
      calls += 1;
      return { commit_sha: sha };
    };
    const resolved = resolvePluginOptions({ appToken: 't', projectRoot: '/watch-root' }, {});
    await runPluginUpload(resolved, '/out-watch-1', { uploadSourcemaps, resolveVcs });
    await runPluginUpload(resolved, '/out-watch-2', { uploadSourcemaps, resolveVcs });
    expect(calls).toBe(2);
  });

  it('routes a VCS notice to the plugin’s onNotice sink, prefixed — NOT to onError', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: true,
        deletedMaps: [],
      }),
    );
    const notices: string[] = [];
    const errors: unknown[] = [];
    const resolveVcs = async (o: ResolveVcsMetadataOptions): Promise<VcsMetadata | undefined> => {
      o.onNotice?.('the tree was dirty');
      return undefined;
    };
    const resolved = resolvePluginOptions(
      {
        appToken: 't',
        projectRoot: '/notice-root',
        onNotice: (m) => notices.push(m),
        onError: (e) => errors.push(e),
      },
      {},
    );
    await runPluginUpload(resolved, '/out-notice', { uploadSourcemaps, resolveVcs });
    expect(notices).toEqual(['[bugsee] the tree was dirty']);
    // `onError` is documented as taking a contained FAILURE and everywhere else receives an `Error`;
    // hosts do `e.message` / `e instanceof Error` / fail-the-pipeline-if-non-empty on it. A plain
    // informational string about a dirty tree breaks all three.
    expect(errors).toEqual([]);
  });

  it('falls back to a console warning when no onNotice sink is configured', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: true,
        deletedMaps: [],
      }),
    );
    const resolveVcs = async (o: ResolveVcsMetadataOptions): Promise<VcsMetadata | undefined> => {
      o.onNotice?.('no sink configured');
      return undefined;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const resolved = resolvePluginOptions({ appToken: 't', projectRoot: '/warn-root-2' }, {});
      await runPluginUpload(resolved, '/out-warn-2', { uploadSourcemaps, resolveVcs });
      expect(warn).toHaveBeenCalledWith('[bugsee] no sink configured');
    } finally {
      warn.mockRestore();
    }
  });

  it('reports what it captured on a DRY RUN — the documented way to confirm capture works', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: false,
        deletedMaps: [],
      }),
    );
    const notices: string[] = [];
    const resolveVcs = async (): Promise<VcsMetadata | undefined> => ({ commit_sha: sha });
    const resolved = resolvePluginOptions(
      { appToken: 't', dryRun: true, projectRoot: '/dry', onNotice: (m) => notices.push(m) },
      {},
    );
    await runPluginUpload(resolved, '/out-dry', { uploadSourcemaps, resolveVcs });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(sha);
  });

  it('says so on a DRY RUN when nothing was captured', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: false,
        deletedMaps: [],
      }),
    );
    const notices: string[] = [];
    const resolveVcs = async (): Promise<VcsMetadata | undefined> => undefined;
    const resolved = resolvePluginOptions(
      { appToken: 't', dryRun: true, projectRoot: '/dry2', onNotice: (m) => notices.push(m) },
      {},
    );
    await runPluginUpload(resolved, '/out-dry2', { uploadSourcemaps, resolveVcs });
    expect(notices).toEqual(['[bugsee] no VCS metadata was captured for this build']);
  });

  it('KEEPS the captured metadata when a dry-run notice sink throws', async () => {
    // The dry-run diagnostic calls the sink DIRECTLY, inside the try whose catch discards the metadata
    // — so an unguarded throw here cost the caller the whole VcsMetadata object (branch, repo,
    // provider, everything), which is the precise trade the resolver's contract says never to make.
    // The resolver guards its own notices; this pins the same property at the layer that OWNS the sink.
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: false,
        deletedMaps: [],
      }),
    );
    const resolveVcs = async (): Promise<VcsMetadata | undefined> => ({ commit_sha: sha });
    const resolved = resolvePluginOptions(
      {
        appToken: 't',
        dryRun: true,
        projectRoot: '/dry-throw',
        onNotice: () => {
          throw new Error('logger exploded');
        },
      },
      {},
    );
    const result = await runPluginUpload(resolved, '/out-dry-throw', {
      uploadSourcemaps,
      resolveVcs,
    });
    expect(result?.injected).toBe(true);
    expect(uploadSourcemaps.mock.calls[0]?.[0]).toMatchObject({ vcs: { commit_sha: sha } });
  });

  it('survives a throwing console.warn on the default sink path', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: false,
        deletedMaps: [],
      }),
    );
    const resolveVcs = async (): Promise<VcsMetadata | undefined> => ({ commit_sha: sha });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('stdout is closed');
    });
    try {
      const resolved = resolvePluginOptions(
        { appToken: 't', dryRun: true, projectRoot: '/dry-warn-throw' },
        {},
      );
      const result = await runPluginUpload(resolved, '/out-dry-warn-throw', {
        uploadSourcemaps,
        resolveVcs,
      });
      expect(uploadSourcemaps.mock.calls[0]?.[0]).toMatchObject({ vcs: { commit_sha: sha } });
      expect(result?.injected).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays SILENT about capture on a normal (non-dry) build', async () => {
    const uploadSourcemaps = vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: true,
        deletedMaps: [],
      }),
    );
    const notices: string[] = [];
    const resolveVcs = async (): Promise<VcsMetadata | undefined> => ({ commit_sha: sha });
    const resolved = resolvePluginOptions(
      { appToken: 't', projectRoot: '/quiet', onNotice: (m) => notices.push(m) },
      {},
    );
    await runPluginUpload(resolved, '/out-quiet', { uploadSourcemaps, resolveVcs });
    expect(notices).toEqual([]);
  });

  it('CONTAINS a process.cwd() that throws — an unlinked working directory must not fail the build', async () => {
    // `process.cwd()` throws ENOENT/uncwd when the directory has been unlinked, which a build script
    // that removes and recreates its own directory really does. The upload must still run.
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
      }),
    );
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory, uv_cwd');
    });
    try {
      const resolved = resolvePluginOptions({ appToken: 't' }, {});
      const result = await runPluginUpload(resolved, '/out-uncwd', {
        uploadSourcemaps,
        resolveVcs,
      });
      expect(result?.uploaded).toBe(true);
      expect(resolveVcs).not.toHaveBeenCalled();
      expect(uploadSourcemaps.mock.calls[0]?.[0]).not.toHaveProperty('vcs');
    } finally {
      cwd.mockRestore();
    }
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
  const upload = () =>
    vi.fn(
      async (_o: UploadSourcemapsOptions): Promise<UploadSourcemapsResult> => ({
        injected: true,
        uploaded: true,
        deletedMaps: [],
      }),
    );

  it('actually CALLS resolveVcsMetadata when no seam is injected', async () => {
    const uploadSourcemaps = upload();
    const sha = 'c'.repeat(40);
    // The real resolver, exercised end to end with nothing stubbed at this layer. `BUGSEE_CLI_PATH`
    // points at a binary that fails, so `bugsee-cli vcs-metadata` yields nothing and no network or git
    // state is involved; the commit can then ONLY have come from the real resolver reading the real
    // override. Severing the default to `async () => undefined` — the mutation the previous version of
    // this test could not see — makes the `vcs` key vanish and this fail.
    const previousCli = process.env.BUGSEE_CLI_PATH;
    process.env.BUGSEE_CLI_PATH = '/nonexistent/bugsee-cli-that-cannot-run';
    try {
      const resolved = resolvePluginOptions({ appToken: 't', commit: sha }, {});
      await runPluginUpload(resolved, '/out-vcs-default-a', { uploadSourcemaps });
      expect(uploadSourcemaps.mock.calls[0]?.[0]).toMatchObject({ vcs: { commit_sha: sha } });
    } finally {
      if (previousCli === undefined) {
        delete process.env.BUGSEE_CLI_PATH;
      } else {
        process.env.BUGSEE_CLI_PATH = previousCli;
      }
    }
  });

  it('short-circuits inside the real resolver when VCS is off, forking nothing', async () => {
    const uploadSourcemaps = upload();
    const resolved = resolvePluginOptions(
      { appToken: 't', vcs: false, commit: 'd'.repeat(40) },
      {},
    );
    await runPluginUpload(resolved, '/out-vcs-default-b', { uploadSourcemaps });
    expect(uploadSourcemaps).toHaveBeenCalledTimes(1);
    // Even with a valid explicit commit: `enabled: false` wins over everything.
    expect(uploadSourcemaps.mock.calls[0]?.[0]).not.toHaveProperty('vcs');
  });
});
