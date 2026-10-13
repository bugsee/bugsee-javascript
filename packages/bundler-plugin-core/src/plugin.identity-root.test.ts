// The app identity is read from the BUNDLER's project directory, not from the VCS `projectRoot`, and the
// baked `define` and the uploaded value come from the one resolution. Real files, a real monorepo layout.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnpluginOptions } from 'unplugin';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CI_COMMIT_ENV_VARS } from './app-identity';
import type { BugseePluginOptions, ResolvedPluginOptions } from './resolve';

const { uploadSpy } = vi.hoisted(() => ({
  uploadSpy: vi.fn(async (_resolved: unknown, _outDir: string, _deps?: unknown) => undefined),
}));
vi.mock('./resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resolve')>()),
  runPluginUpload: uploadSpy,
}));

const { bugseeUnpluginFactory } = await import('./plugin');

const make = (options: BugseePluginOptions): UnpluginOptions =>
  bugseeUnpluginFactory(options, { framework: 'rollup' }) as UnpluginOptions;

let repo: string;
let web: string;
let bare: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'bugsee-identity-'));
  writeFileSync(join(repo, 'package.json'), '{"name":"workspace","version":"0.0.0"}');
  web = join(repo, 'apps', 'web');
  mkdirSync(join(web, 'dist'), { recursive: true });
  writeFileSync(join(web, 'package.json'), '{"name":"web","version":"2.4.1"}');
  // A package with no version of its own, under a workspace that has one.
  bare = join(repo, 'apps', 'bare');
  mkdirSync(join(bare, 'dist'), { recursive: true });
  writeFileSync(join(bare, 'package.json'), '{"name":"bare"}');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  uploadSpy.mockClear();
  vi.stubEnv('BUGSEE_APP_VERSION', '');
  vi.stubEnv('BUGSEE_APP_BUILD', '');
  for (const name of CI_COMMIT_ENV_VARS) {
    vi.stubEnv(name, '');
  }
});

const uploaded = (): ResolvedPluginOptions => uploadSpy.mock.calls[0]?.[0] as ResolvedPluginOptions;

type ViteConfig = (c: { root?: string }) => { define?: Record<string, string> } | undefined;
const viteConfig = (p: UnpluginOptions): ViteConfig =>
  (p.vite as unknown as { config: ViteConfig }).config;
type WriteBundle = (output: { dir?: string }) => Promise<void>;
const viteWriteBundle = (p: UnpluginOptions): WriteBundle =>
  (p.vite as unknown as { writeBundle: WriteBundle }).writeBundle;

class FakeDefine {
  static applied: Array<Record<string, string>> = [];
  constructor(readonly definitions: Record<string, string>) {}
  apply() {
    FakeDefine.applied.push(this.definitions);
  }
}
const webpackCompiler = (context: string | undefined, outputPath: string) => {
  const taps: Array<() => Promise<void>> = [];
  return {
    taps,
    compiler: {
      context,
      options: { plugins: [], output: { path: outputPath } },
      hooks: {
        afterEmit: { tapPromise: (_n: string, fn: () => Promise<void>) => taps.push(fn) },
      },
      webpack: { DefinePlugin: FakeDefine },
      rspack: { DefinePlugin: FakeDefine },
    },
  };
};

describe('monorepo: workspace root 0.0.0, apps/web 2.4.1, VCS projectRoot = the repo root', () => {
  it('vite: the define and the upload both carry the app version from config.root', async () => {
    const plugin = make({ appToken: 't', projectRoot: repo });
    const defined = viteConfig(plugin)({ root: web })?.define;
    expect(defined).toEqual({ __BUGSEE_APP_VERSION__: '"2.4.1"' });
    await viteWriteBundle(plugin)({ dir: join(web, 'dist') });
    expect(uploaded().appVersion).toBe('2.4.1');
    expect(uploaded().projectRoot).toBe(repo);
  });

  it('vite: a relative config.root is resolved against the working directory', () => {
    const plugin = make({});
    expect(viteConfig(plugin)({ root: '.' })?.define).toEqual({
      __BUGSEE_APP_VERSION__: expect.stringMatching(/^"\d/),
    });
  });

  it('webpack: the define and the upload both carry the version from compiler.context', async () => {
    FakeDefine.applied = [];
    const { compiler, taps } = webpackCompiler(web, join(web, 'dist'));
    (make({ appToken: 't', projectRoot: repo }).webpack as (c: unknown) => void)(compiler);
    expect(FakeDefine.applied).toEqual([{ __BUGSEE_APP_VERSION__: '"2.4.1"' }]);
    await taps[0]?.();
    expect(uploaded().appVersion).toBe('2.4.1');
  });

  it('rspack: the define comes from compiler.context', () => {
    FakeDefine.applied = [];
    const { compiler } = webpackCompiler(web, join(web, 'dist'));
    (make({ projectRoot: repo }).rspack as (c: unknown) => void)(compiler);
    expect(FakeDefine.applied).toEqual([{ __BUGSEE_APP_VERSION__: '"2.4.1"' }]);
  });

  it('esbuild: the define comes from absWorkingDir', () => {
    const options: { define?: Record<string, string>; absWorkingDir?: string } = {
      absWorkingDir: web,
    };
    (make({ projectRoot: repo }).esbuild as unknown as { config: (o: unknown) => void }).config(
      options,
    );
    expect(options.define).toEqual({ __BUGSEE_APP_VERSION__: '"2.4.1"' });
  });

  it('rollup (no root hook): the upload resolves from the output directory upward', async () => {
    const rollup = make({ appToken: 't', projectRoot: repo }).rollup as unknown as {
      writeBundle: WriteBundle;
    };
    await rollup.writeBundle({ dir: join(web, 'dist') });
    expect(uploaded().appVersion).toBe('2.4.1');
  });

  it('a nearest package.json without a version means no version, not the workspace one', async () => {
    const plugin = make({ appToken: 't', projectRoot: repo });
    expect(viteConfig(plugin)({ root: bare })?.define).toBeUndefined();
    await viteWriteBundle(plugin)({ dir: join(bare, 'dist') });
    expect(uploaded().appVersion).toBe('0.0.0');
    expect(uploaded().identityDefines).toEqual({});
  });
});

describe('blank appVersion / appBuild options', () => {
  it('fall through to package.json, and the baked and uploaded values agree', async () => {
    const plugin = make({ appToken: 't', appVersion: '  ', appBuild: '' });
    expect(viteConfig(plugin)({ root: web })?.define).toEqual({
      __BUGSEE_APP_VERSION__: '"2.4.1"',
    });
    await viteWriteBundle(plugin)({ dir: join(web, 'dist') });
    expect(uploaded()).toMatchObject({ appVersion: '2.4.1' });
  });

  it('with nothing to fall through to, upload the placeholders and bake nothing', async () => {
    const plugin = make({ appToken: 't', appVersion: ' ', appBuild: ' ' });
    expect(viteConfig(plugin)({ root: bare })?.define).toBeUndefined();
    await viteWriteBundle(plugin)({ dir: join(bare, 'dist') });
    expect(uploaded()).toMatchObject({ appVersion: '0.0.0', appBuild: '0', identityDefines: {} });
  });
});
