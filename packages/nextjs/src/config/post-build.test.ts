import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BuildFiles } from './build-files';
import type { BugseeNextContext } from './context';
import { runPostBuild } from './post-build';

const files = (name: string): BuildFiles => ({
  scripts: [`/d/${name}.js`],
  maps: [`/d/${name}.js.map`],
  stylesheetMaps: [],
});
const none: BuildFiles = { scripts: [], maps: [], stylesheetMaps: [] };

function context(
  overrides: Partial<BugseeNextContext['resolved']> = {},
  extra: Partial<BugseeNextContext> = {},
): BugseeNextContext {
  return {
    resolved: {
      enabled: true,
      appToken: 't',
      deleteMaps: true,
      registerBuild: 'release',
      ...overrides,
    } as BugseeNextContext['resolved'],
    serverSourceMaps: true,
    deleteServerMaps: false,
    say: vi.fn(),
    ...extra,
  };
}

const metadata = { projectDir: '/app', distDir: '/app/.next' };

function deps(map: Record<string, BuildFiles>, sri = false) {
  return {
    upload: vi.fn(async () => undefined),
    collect: vi.fn(async (dir: string) => map[dir] ?? none),
    exists: vi.fn(async () => sri),
  };
}

describe('runPostBuild', () => {
  it('does nothing when disabled', async () => {
    const d = deps({});
    await runPostBuild(context({ enabled: false }), metadata, d);
    expect(d.collect).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it('uploads the browser output, then the server output, each over its own explicit files', async () => {
    const client = files('client');
    const server = files('server');
    const d = deps({ '/app/.next/static': client, '/app/.next/server': server });
    await runPostBuild(context(), metadata, d);
    expect(d.upload).toHaveBeenCalledTimes(2);
    type Call = [
      Record<string, unknown>,
      string,
      { files: BuildFiles; preStamped?: boolean; bundler: unknown },
    ];
    const [first, second] = (d.upload as ReturnType<typeof vi.fn>).mock.calls as [Call, Call];
    expect(first[1]).toBe('/app/.next/static');
    expect(first[2].files).toBe(client);
    expect(first[0]).toMatchObject({ deleteMaps: true, registerBuild: 'release' });
    expect(second[1]).toBe('/app/.next/server');
    expect(second[2].files).toBe(server);
    // Server output: the server deletion policy, and the build is registered once (by the browser run).
    expect(second[0]).toMatchObject({ deleteMaps: false, registerBuild: false });
    // Stamped AFTER emit: not pre-stamped.
    expect(first[2].preStamped).toBeUndefined();
    expect(first[2].bundler).toEqual({ isProduction: true, configuration: 'production' });
  });

  it('resolves a relative distDir against the project directory', async () => {
    const d = deps({ '/app/.next/static': files('c') });
    await runPostBuild(context(), { projectDir: '/app', distDir: '.next' }, d);
    expect(d.collect).toHaveBeenCalledWith('/app/.next/static');
  });

  it('honours deleteServerMaps', async () => {
    const d = deps({ '/app/.next/server': files('s') });
    await runPostBuild(context({}, { deleteServerMaps: true }), metadata, d);
    const [resolved] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(resolved).toMatchObject({ deleteMaps: true });
  });

  it('skips the server output entirely when server maps are off', async () => {
    const d = deps({ '/app/.next/static': files('c'), '/app/.next/server': files('s') });
    await runPostBuild(context({}, { serverSourceMaps: false }), metadata, d);
    expect(d.collect).not.toHaveBeenCalledWith('/app/.next/server');
    expect(d.upload).toHaveBeenCalledTimes(1);
  });

  it('says so, and uploads nothing for the browser, when it emitted no maps', async () => {
    const ctx = context();
    const d = deps({ '/app/.next/server': files('s') });
    await runPostBuild(ctx, metadata, d);
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('productionBrowserSourceMaps'));
    expect(d.upload).toHaveBeenCalledTimes(1);
  });

  it('says how many bundles were left unstamped because they share a map', async () => {
    const ctx = context();
    const d = deps({
      '/app/.next/static': { ...files('c'), shared: ['/d/x.js'] },
      '/app/.next/server': { ...files('s'), shared: ['/d/y.js', '/d/z.js'] },
    });
    await runPostBuild(ctx, metadata, d);
    expect(ctx.say).toHaveBeenCalledWith(
      expect.stringContaining('3 bundle(s) share one source map'),
    );
    expect(d.upload).toHaveBeenCalledTimes(2);
  });

  it('only says the browser emitted no maps when maps were expected', async () => {
    const off = context({}, { browserMaps: false });
    await runPostBuild(off, metadata, deps({ '/app/.next/server': files('s') }));
    expect(off.say).not.toHaveBeenCalled();
    const expected = context({}, { browserMaps: true });
    await runPostBuild(expected, metadata, deps({ '/app/.next/server': files('s') }));
    expect(expected.say).toHaveBeenCalledWith(expect.stringContaining('emitted no source maps'));
  });

  it('says the shared map itself stays (and is public) when it is in .next/static', async () => {
    const ctx = context();
    const d = deps({ '/app/.next/static': { ...files('c'), shared: ['/d/x.js'] } });
    await runPostBuild(ctx, metadata, d);
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('neither uploaded nor deleted'));
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('publicly served'));
  });

  it('registers the build from the server run when the browser had nothing to upload', async () => {
    const d = deps({ '/app/.next/server': files('s') });
    await runPostBuild(context(), metadata, d);
    const [resolved] = (d.upload as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(resolved.registerBuild).toBe('release');
  });

  it('stays quiet about shared maps when there are none', async () => {
    const ctx = context();
    await runPostBuild(ctx, metadata, deps({ '/app/.next/static': files('c') }));
    expect(ctx.say).not.toHaveBeenCalled();
  });

  it('leaves an SRI build exactly as Next wrote it, and says why', async () => {
    const ctx = context();
    const d = deps({ '/app/.next/static': files('c'), '/app/.next/server': files('s') }, true);
    await runPostBuild(ctx, metadata, d);
    expect(d.exists).toHaveBeenCalledWith('/app/.next/server/subresource-integrity-manifest.json');
    expect(d.collect).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('Subresource Integrity'));
  });

  it('leaves the build alone, without looking at the disk, when the config says SRI', async () => {
    const ctx = context({}, { sri: true });
    const d = deps({ '/app/.next/static': files('c') });
    await runPostBuild(ctx, metadata, d);
    expect(d.exists).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('publicly served'));
  });

  it('uses the real upload, collector and filesystem when none are injected', async () => {
    const ctx = context();
    // Nothing exists under this directory: no SRI manifest, no files, so no upload, only the notice.
    await expect(
      runPostBuild(ctx, { projectDir: '/definitely/not/here', distDir: '.next' }),
    ).resolves.toBeUndefined();
    expect(ctx.say).toHaveBeenCalledTimes(1);
  });
});

describe('runPostBuild: containment', () => {
  const boom = (): never => {
    throw new Error('disk on fire');
  };

  it('a failure in collecting files never fails the build by default, and goes to onError', async () => {
    const onError = vi.fn();
    const d = { ...deps({}), collect: vi.fn(async () => boom()) };
    await expect(runPostBuild(context({ onError }), metadata, d)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk on fire' }));
  });

  it('warns on the console when there is no onError', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = { ...deps({}), collect: vi.fn(async () => boom()) };
    await runPostBuild(context(), metadata, d);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk on fire'));
    warn.mockRestore();
  });

  it('a failure in the upload is contained the same way', async () => {
    const onError = vi.fn();
    const d = { ...deps({ '/app/.next/static': files('c') }), upload: vi.fn(async () => boom()) };
    await expect(runPostBuild(context({ onError }), metadata, d)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('rethrows under failOnError', async () => {
    const d = { ...deps({}), collect: vi.fn(async () => boom()) };
    await expect(runPostBuild(context({ failOnError: true }), metadata, d)).rejects.toThrow(
      'disk on fire',
    );
  });

  it('an unreadable bundle on disk does not fail the build', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-pb-'));
    try {
      mkdirSync(join(dir, '.next', 'static'), { recursive: true });
      const bundle = join(dir, '.next', 'static', 'a.js');
      writeFileSync(bundle, 'x');
      chmodSync(bundle, 0o000);
      const onError = vi.fn();
      await expect(
        runPostBuild(context({ onError }), { projectDir: dir, distDir: '.next' }),
      ).resolves.toBeUndefined();
      // Root can read it anyway; everyone else must see the failure reported, not thrown.
      expect(onError).toHaveBeenCalledTimes(process.getuid?.() === 0 ? 0 : 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
