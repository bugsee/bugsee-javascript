// The app's version/build reach the bundle through each bundler's own `define`, token or not.
import type { UnpluginOptions } from 'unplugin';
import { describe, expect, it } from 'vitest';
import { bugseeUnpluginFactory } from './plugin';
import type { BugseePluginOptions } from './resolve';

const make = (options: BugseePluginOptions): UnpluginOptions =>
  bugseeUnpluginFactory(
    { appVersion: '1.2.3', appBuild: 'abc', ...options },
    { framework: 'rollup' },
  ) as UnpluginOptions;

const DEFINES = { __BUGSEE_APP_VERSION__: '"1.2.3"', __BUGSEE_APP_BUILD__: '"abc"' };

type ViteConfig = (c: {
  build?: { sourcemap?: boolean | string };
  define?: Record<string, unknown>;
}) => { build?: unknown; define?: Record<string, string> } | undefined;
const viteConfig = (p: UnpluginOptions): ViteConfig =>
  (p.vite as unknown as { config: ViteConfig }).config;

describe('vite config()', () => {
  it('injects both constants without a token, and does not touch sourcemaps', () => {
    expect(viteConfig(make({}))({})).toEqual({ define: DEFINES });
  });

  it('adds define next to the sourcemap default when enabled', () => {
    expect(viteConfig(make({ appToken: 't' }))({})).toEqual({
      build: { sourcemap: true },
      define: DEFINES,
    });
  });

  it('leaves a deliberate sourcemap choice alone but still defines', () => {
    expect(viteConfig(make({ appToken: 't' }))({ build: { sourcemap: 'hidden' } })).toEqual({
      define: DEFINES,
    });
  });

  it('never overrides the user’s own define of the same key', () => {
    const result = viteConfig(make({}))({ define: { __BUGSEE_APP_VERSION__: '"9"' } });
    expect(result).toEqual({ define: { __BUGSEE_APP_BUILD__: '"abc"' } });
  });

  it('returns nothing when the user defined both and no maps are wanted', () => {
    expect(
      viteConfig(make({}))({ define: { __BUGSEE_APP_VERSION__: '1', __BUGSEE_APP_BUILD__: '2' } }),
    ).toBeUndefined();
  });

  it('a disabled plugin alters nothing', () => {
    expect(viteConfig(make({ appToken: 't', disabled: true }))({})).toBeUndefined();
  });
});

describe('esbuild config()', () => {
  type EsbuildConfig = (o: { define?: Record<string, string> }) => void;
  const esbuildConfig = (p: UnpluginOptions): EsbuildConfig =>
    (p.esbuild as unknown as { config: EsbuildConfig }).config;

  it('writes the defines into initialOptions, keeping the user’s own', () => {
    const options: { define?: Record<string, string> } = { define: { A: '1' } };
    esbuildConfig(make({}))(options);
    expect(options.define).toEqual({ A: '1', ...DEFINES });
    const own: { define?: Record<string, string> } = {
      define: { __BUGSEE_APP_VERSION__: '"9"' },
    };
    esbuildConfig(make({}))(own);
    expect(own.define).toEqual({ __BUGSEE_APP_VERSION__: '"9"', __BUGSEE_APP_BUILD__: '"abc"' });
  });

  it('adds nothing, and creates no define object, when disabled', () => {
    const options: { define?: Record<string, string> } = {};
    esbuildConfig(make({ disabled: true }))(options);
    expect(options).toEqual({});
  });
});

describe('webpack / rspack DefinePlugin', () => {
  class FakeDefine {
    static applied: Array<Record<string, string>> = [];
    constructor(readonly definitions: Record<string, string>) {}
    apply() {
      FakeDefine.applied.push(this.definitions);
    }
  }
  const compiler = (plugins: unknown[] = []) => ({
    options: { plugins, output: {} },
    hooks: { afterEmit: { tapPromise: () => undefined } },
    webpack: { DefinePlugin: FakeDefine },
    rspack: { DefinePlugin: FakeDefine },
  });

  it('webpack applies a DefinePlugin from compiler.webpack with the constants', () => {
    FakeDefine.applied = [];
    (make({}).webpack as (c: unknown) => void)(compiler());
    expect(FakeDefine.applied).toEqual([DEFINES]);
  });

  it('rspack applies one from compiler.rspack', () => {
    FakeDefine.applied = [];
    (make({}).rspack as (c: unknown) => void)(compiler());
    expect(FakeDefine.applied).toEqual([DEFINES]);
  });

  it('skips keys another DefinePlugin already defines, and tolerates odd plugin entries', () => {
    FakeDefine.applied = [];
    const existing = new FakeDefine({ __BUGSEE_APP_BUILD__: '"mine"' });
    (make({}).webpack as (c: unknown) => void)(compiler([existing, null, {}, { definitions: 1 }]));
    expect(FakeDefine.applied).toEqual([{ __BUGSEE_APP_VERSION__: '"1.2.3"' }]);
  });

  it('applies nothing when every key is taken, when disabled, or when there is no DefinePlugin', () => {
    FakeDefine.applied = [];
    const all = new FakeDefine(DEFINES);
    (make({}).webpack as (c: unknown) => void)(compiler([all]));
    (make({ disabled: true }).webpack as (c: unknown) => void)(compiler());
    const bare = { ...compiler(), webpack: undefined, rspack: undefined };
    (make({}).webpack as (c: unknown) => void)(bare);
    (make({}).rspack as (c: unknown) => void)(bare);
    expect(FakeDefine.applied).toEqual([]);
  });

  it('tolerates a compiler with no plugins array', () => {
    FakeDefine.applied = [];
    const c = compiler();
    (c.options as { plugins?: unknown[] }).plugins = undefined;
    (make({}).webpack as (x: unknown) => void)(c);
    expect(FakeDefine.applied).toEqual([DEFINES]);
  });
});
