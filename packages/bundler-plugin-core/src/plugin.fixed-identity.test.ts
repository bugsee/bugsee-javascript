// The upload / registration label and the constants the app actually reads must agree, on every bundler:
//  - a version/build the user defines themselves IS the identity (a JSON string literal), and an expression
//    we cannot read is never replaced by a different auto-detected value (explicit values only);
//  - Rollup and a webpack without a DefinePlugin cannot be told what the bundle reports, so Rollup bakes the
//    value itself and an un-bakeable path labels with explicit values only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAst } from 'rollup/parseAst';
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
  bugseeUnpluginFactory({ appToken: 't', ...options }, { framework: 'rollup' }) as UnpluginOptions;

let web: string;
let repo: string;
let mid: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'bugsee-fixed-identity-'));
  web = join(repo, 'apps', 'web');
  mkdirSync(join(web, 'dist'), { recursive: true });
  writeFileSync(join(web, 'package.json'), '{"name":"web","version":"2.4.1"}');
  mid = join(repo, 'apps', 'mid');
  mkdirSync(join(mid, 'dist'), { recursive: true });
  writeFileSync(join(mid, 'package.json'), '{"name":"mid","version":"1.0.0"}');
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

const uploaded = (call = 0): ResolvedPluginOptions =>
  uploadSpy.mock.calls[call]?.[0] as ResolvedPluginOptions;

type ViteConfig = (c: { root?: string; define?: Record<string, unknown> }) => unknown;
const viteConfig = (p: UnpluginOptions): ViteConfig =>
  (p.vite as unknown as { config: ViteConfig }).config;
type WriteBundle = (output: { dir?: string }) => Promise<void>;
const viteWriteBundle = (p: UnpluginOptions): WriteBundle =>
  (p.vite as unknown as { writeBundle: WriteBundle }).writeBundle;

const VERSION = '__BUGSEE_APP_VERSION__';
const BUILD = '__BUGSEE_APP_BUILD__';

describe('a user define of the identity constants is the identity for the upload too', () => {
  it('vite: a string-literal define is uploaded (not the package.json version)', async () => {
    const plugin = make({});
    viteConfig(plugin)({ root: web, define: { [VERSION]: JSON.stringify('9.9.9') } });
    await viteWriteBundle(plugin)({ dir: join(web, 'dist') });
    expect(uploaded().appVersion).toBe('9.9.9');
  });

  it('vite: an expression define is NOT replaced by the detected version — explicit values only', async () => {
    const plugin = make({});
    viteConfig(plugin)({ root: web, define: { [VERSION]: 'process.env.APP_VERSION' } });
    await viteWriteBundle(plugin)({ dir: join(web, 'dist') });
    expect(uploaded().appVersion).toBe('0.0.0');
    const explicit = make({ appVersion: '3.0.0' });
    viteConfig(explicit)({ root: web, define: { [VERSION]: 'process.env.APP_VERSION' } });
    await viteWriteBundle(explicit)({ dir: join(web, 'dist') });
    expect(uploaded(1).appVersion).toBe('3.0.0');
  });

  it('vite: the other, undefined constant is still detected and baked', async () => {
    const plugin = make({ appBuild: 'b1' });
    const result = viteConfig(plugin)({
      root: web,
      define: { [VERSION]: JSON.stringify('9.9.9') },
    }) as { define: Record<string, string> };
    expect(result.define).toEqual({ [BUILD]: '"b1"' });
    await viteWriteBundle(plugin)({ dir: join(web, 'dist') });
    expect(uploaded()).toMatchObject({ appVersion: '9.9.9', appBuild: 'b1' });
  });

  it('esbuild: the user define is the uploaded identity', async () => {
    const plugin = make({});
    const options: { define?: Record<string, string>; absWorkingDir?: string } = {
      absWorkingDir: web,
      define: { [VERSION]: JSON.stringify('9.9.9') },
    };
    (plugin.esbuild as unknown as { config: (o: unknown) => void }).config(options);
    expect(options.define?.[VERSION]).toBe('"9.9.9"'); // the user's own value is kept
    await (plugin.rollup as unknown as { writeBundle: WriteBundle }).writeBundle({
      dir: join(web, 'dist'),
    });
    expect(uploaded().appVersion).toBe('9.9.9');
  });

  it('webpack: an existing DefinePlugin of the constant is the uploaded identity', async () => {
    const taps: Array<() => Promise<void>> = [];
    const compiler = {
      context: web,
      options: {
        plugins: [{ definitions: { [VERSION]: JSON.stringify('9.9.9') } }],
        output: { path: join(web, 'dist') },
      },
      hooks: { afterEmit: { tapPromise: (_n: string, fn: () => Promise<void>) => taps.push(fn) } },
      webpack: {
        DefinePlugin: class {
          apply() {}
        },
      },
    };
    (make({}).webpack as (c: unknown) => void)(compiler);
    await taps[0]?.();
    expect(uploaded().appVersion).toBe('9.9.9');
  });

  it("webpack 4 (no DefinePlugin of its own) still honours the user's own DefinePlugin literal", async () => {
    const taps: Array<() => Promise<void>> = [];
    const compiler = {
      context: web,
      options: {
        plugins: [{ definitions: { [VERSION]: JSON.stringify('9.9.9') } }],
        output: { path: join(web, 'dist') },
      },
      hooks: { afterEmit: { tapPromise: (_n: string, fn: () => Promise<void>) => taps.push(fn) } },
    };
    (make({}).webpack as (c: unknown) => void)(compiler);
    await taps[0]?.();
    expect(uploaded()).toMatchObject({ appVersion: '9.9.9', appBuild: '0' });
  });

  it('rspack: a user-defined constant is not baked again, and the other still is', () => {
    const applied: Array<Record<string, string>> = [];
    const compiler = {
      context: web,
      options: { plugins: [{ definitions: { [VERSION]: '"9.9.9"' } }], output: {} },
      hooks: { afterEmit: { tapPromise: () => undefined } },
      rspack: {
        DefinePlugin: class {
          constructor(readonly definitions: Record<string, string>) {}
          apply() {
            applied.push(this.definitions);
          }
        },
      },
    };
    (make({ appBuild: 'b1' }).rspack as (c: unknown) => void)(compiler);
    expect(applied).toEqual([{ [BUILD]: '"b1"' }]);
  });
});

describe('an identity constant the plugin cannot read is REPORTED, not silently uploaded as 0.0.0', () => {
  const expression = { [VERSION]: 'process.env.APP_VERSION', [BUILD]: 'process.env.APP_BUILD' };

  it('vite: an expression define with no explicit value raises one notice per constant', () => {
    const onNotice = vi.fn();
    viteConfig(make({ onNotice }))({ root: web, define: expression });
    expect(onNotice).toHaveBeenCalledTimes(2);
    const [version, build] = onNotice.mock.calls.map(([m]) => m as string);
    expect(version).toMatch(/^\[bugsee\] /);
    expect(version).toContain(`your own define of ${VERSION}`);
    expect(version).toContain('`appVersion`');
    expect(version).toContain('(or BUGSEE_APP_VERSION)');
    expect(version).not.toContain('appBuild');
    expect(build).toContain(`your own define of ${BUILD}`);
    expect(build).toContain('`appBuild`');
    expect(build).toContain('(or BUGSEE_APP_BUILD)');
  });

  it('esbuild: the same notice for an expression define', () => {
    const onNotice = vi.fn();
    const options = { absWorkingDir: web, define: { [VERSION]: 'globalThis.v' } };
    (make({ onNotice }).esbuild as unknown as { config: (o: unknown) => void }).config(options);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice.mock.calls[0]?.[0]).toContain(`your own define of ${VERSION}`);
  });

  it.each([
    'webpack',
    'rspack',
  ] as const)('%s 5: an expression in the user DefinePlugin is reported as their define, not as a missing DefinePlugin', (bundler) => {
    const onNotice = vi.fn();
    const DefinePlugin = class {
      apply() {}
    };
    const compiler = {
      context: web,
      options: { plugins: [{ definitions: { [VERSION]: 'process.env.V' } }], output: {} },
      hooks: { afterEmit: { tapPromise: () => undefined } },
      [bundler]: { DefinePlugin },
    };
    (make({ onNotice, appBuild: 'b1' })[bundler] as (c: unknown) => void)(compiler);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice.mock.calls[0]?.[0]).toContain(`your own define of ${VERSION}`);
  });

  it('an explicit value (option or env) answers the field, so nothing is reported for it', () => {
    const onNotice = vi.fn();
    viteConfig(make({ onNotice, appVersion: '3.0.0' }))({ root: web, define: expression });
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice.mock.calls[0]?.[0]).toContain(BUILD);
    vi.stubEnv('BUGSEE_APP_BUILD', '77');
    const quiet = vi.fn();
    viteConfig(make({ onNotice: quiet, appVersion: '3.0.0' }))({ root: web, define: expression });
    expect(quiet).not.toHaveBeenCalled();
  });

  it('a string-literal define, or no define at all, is readable: no notice', () => {
    const onNotice = vi.fn();
    viteConfig(make({ onNotice }))({ root: web, define: { [VERSION]: '"9.9.9"' } });
    viteConfig(make({ onNotice }))({ root: web });
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('nothing is uploaded without a token (or when disabled), so nothing is reported', () => {
    const onNotice = vi.fn();
    const noToken = bugseeUnpluginFactory(
      { appToken: '', onNotice },
      {
        framework: 'rollup',
      },
    ) as UnpluginOptions;
    viteConfig(noToken)({ root: web, define: expression });
    viteConfig(make({ onNotice, disabled: true }))({ root: web, define: expression });
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('webpack 4 (no DefinePlugin): a constant it cannot bake is reported with the webpack-4 remedy', () => {
    const onNotice = vi.fn();
    const compiler = {
      context: web,
      options: { plugins: [], output: { path: join(web, 'dist') } },
      hooks: { afterEmit: { tapPromise: () => undefined } },
    };
    (make({ onNotice }).webpack as (c: unknown) => void)(compiler);
    expect(onNotice).toHaveBeenCalledTimes(2);
    const [version] = onNotice.mock.calls.map(([m]) => m as string);
    expect(version).toContain('no DefinePlugin');
    expect(version).toContain(VERSION);
    expect(version).not.toContain('your own define');
    expect(version).toContain('launch()');
  });

  it("webpack 4: the user's own DefinePlugin literal answers its constant; only the other is reported", () => {
    const onNotice = vi.fn();
    const compiler = {
      context: web,
      options: { plugins: [{ definitions: { [VERSION]: '"9.9.9"' } }], output: {} },
      hooks: { afterEmit: { tapPromise: () => undefined } },
    };
    (make({ onNotice }).webpack as (c: unknown) => void)(compiler);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice.mock.calls[0]?.[0]).toContain(BUILD);
  });

  it('a throwing notice sink cannot break the build', () => {
    const onNotice = vi.fn(() => {
      throw new Error('host logger down');
    });
    expect(() => viteConfig(make({ onNotice }))({ root: web, define: expression })).not.toThrow();
    expect(onNotice).toHaveBeenCalledTimes(2);
  });

  it('defaults to a console warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      viteConfig(make({}))({ root: web, define: { [VERSION]: 'x' } });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(`[bugsee] your own define of ${VERSION}`);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a webpack/rspack with no DefinePlugin cannot bake: label with explicit values only', () => {
  const noDefine = (taps: Array<() => Promise<void>>) => ({
    context: web,
    options: { plugins: [], output: { path: join(web, 'dist') } },
    hooks: { afterEmit: { tapPromise: (_n: string, fn: () => Promise<void>) => taps.push(fn) } },
  });

  it('does not upload the package.json version the bundle will never report', async () => {
    const taps: Array<() => Promise<void>> = [];
    (make({}).webpack as (c: unknown) => void)(noDefine(taps));
    await taps[0]?.();
    expect(uploaded()).toMatchObject({ appVersion: '0.0.0', appBuild: '0' });
  });

  it('still honours an explicit appVersion / appBuild', async () => {
    const taps: Array<() => Promise<void>> = [];
    (make({ appVersion: '5.0.0', appBuild: '12' }).webpack as (c: unknown) => void)(noDefine(taps));
    await taps[0]?.();
    expect(uploaded()).toMatchObject({ appVersion: '5.0.0', appBuild: '12' });
  });
});

describe('rollup bakes the identity itself', () => {
  type RenderChunk = (
    code: string,
    chunk: unknown,
    output: { dir?: string; file?: string },
  ) => { code: string; map: { mappings: string } } | null;
  // Rollup calls the hook with its plugin context; `this.parse` is the parser the bake walks the chunk with.
  const renderChunk = (
    p: UnpluginOptions,
    parse: (code: string) => unknown = parseAst,
  ): RenderChunk =>
    (p.rollup as unknown as { renderChunk: RenderChunk }).renderChunk.bind({ parse });
  const rollupWrite = (p: UnpluginOptions): WriteBundle =>
    (p.rollup as unknown as { writeBundle: WriteBundle }).writeBundle;
  const dist = () => ({ dir: join(web, 'dist') });

  it('replaces the free constants with the detected values and returns a source map', () => {
    const code = `const v = typeof ${VERSION} === 'string' ? ${VERSION} : '0.0.0'; const b = ${BUILD};`;
    const out = renderChunk(make({ appBuild: 'b1' }))(code, {}, dist());
    expect(out?.code).toBe(
      `const v = typeof "2.4.1" === 'string' ? "2.4.1" : '0.0.0'; const b = "b1";`,
    );
    expect(out?.map.mappings).not.toBe('');
  });

  it('a versionless module-type marker package.json in the output dir does not hide the project version', async () => {
    const out = join(web, 'dist', 'cjs');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'package.json'), '{"type":"commonjs"}');
    const plugin = make({});
    expect(renderChunk(plugin)(`f(${VERSION})`, {}, { dir: out })?.code).toBe('f("2.4.1")');
    await rollupWrite(plugin)({ dir: out });
    expect(uploaded().appVersion).toBe('2.4.1');
  });

  it("bakes through Rollup's own this.parse: a quoted name is data, a reference is replaced", () => {
    const parse = vi.fn((code: string) => parseAst(code));
    const code = `const k = "${VERSION}"; f(${VERSION});`;
    const out = renderChunk(make({}), parse)(code, {}, dist());
    expect(parse).toHaveBeenCalledWith(code);
    expect(out?.code).toBe(`const k = "${VERSION}"; f("2.4.1");`);
    expect(() => parseAst(out?.code ?? '')).not.toThrow();
  });

  it('warns once per output when a chunk that mentions the constant cannot be parsed, and never throws', () => {
    const warn = vi.fn();
    const hook = renderChunk(make({}));
    const withWarn = (p: UnpluginOptions) =>
      (p.rollup as unknown as { renderChunk: RenderChunk }).renderChunk.bind({
        parse: parseAst,
        warn,
      });
    const bake = withWarn(make({}));
    expect(bake(`with (o) { f(${VERSION}); }`, {}, dist())).toBeNull();
    expect(bake(`const el = <div>{${VERSION}}</div>;`, {}, dist())).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('NOT baked');
    expect(warn.mock.calls[0]?.[0]).toContain(join(web, 'dist'));
    expect(warn.mock.calls[0]?.[0]).toMatch(/could not be parsed/);
    // another output directory warns again; a chunk that never mentions the constant stays quiet
    expect(bake(`with (o) { f(${VERSION}); }`, {}, { dir: join(web, 'other') })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(bake('with (o) { f(); }', {}, { dir: join(web, 'third') })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(hook(`f(${VERSION})`, {}, dist())?.code).toBe('f("2.4.1")');
  });

  it('warns when the context has no parser, and tolerates a context with no warn', () => {
    const warn = vi.fn();
    const hook = (make({}).rollup as unknown as { renderChunk: RenderChunk }).renderChunk;
    expect(hook.call({ warn }, `f(${VERSION})`, {}, dist())).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/no parser/);
    expect(hook.call(undefined, `f(${VERSION})`, {}, { dir: join(web, 'x') })).toBeNull();
    expect(
      hook.call({ parse: parseAst }, `with (o) { ${VERSION} }`, {}, { dir: join(web, 'y') }),
    ).toBeNull();
  });

  it("calls this.parse and this.warn as methods of Rollup's plugin context", () => {
    const seen: unknown[] = [];
    const ctx = {
      parse(this: unknown, code: string) {
        seen.push(this);
        return parseAst(code);
      },
      warn(this: unknown) {
        seen.push(this);
      },
    };
    const hook = (make({}).rollup as unknown as { renderChunk: RenderChunk }).renderChunk;
    hook.call(ctx, `f(${VERSION})`, {}, dist());
    hook.call(ctx, `with (o) { f(${VERSION}); }`, {}, { dir: join(web, 'ctx') });
    expect(seen).toEqual([ctx, ctx, ctx]);
    expect(seen.every((entry) => entry === ctx)).toBe(true);
  });

  it('bakes a global read past a block-scoped function only when the output is strict', () => {
    const code = `{ function ${VERSION}() {} } use(${VERSION});`;
    const bake = (output: object) => renderChunk(make({}))(code, {}, { ...dist(), ...output });
    expect(bake({ format: 'es' })?.code).toContain('use("2.4.1")');
    expect(bake({ format: 'cjs' })?.code).toContain('use("2.4.1")');
    expect(bake({ format: 'es', strict: false })?.code).toContain('use("2.4.1")');
    expect(bake({ format: 'iife', strict: true })?.code).toContain('use("2.4.1")');
    expect(bake({ format: 'cjs', strict: false })).toBeNull();
    expect(bake({ format: 'umd', strict: false })).toBeNull();
  });

  it('warns again after a new build starts (watch rebuild)', () => {
    const warn = vi.fn();
    const plugin = make({});
    const hook = (plugin.rollup as unknown as { renderChunk: RenderChunk }).renderChunk;
    const buildStart = (plugin.rollup as unknown as { buildStart: () => void }).buildStart;
    const bad = `with (o) { f(${VERSION}); }`;
    hook.call({ parse: parseAst, warn }, bad, {}, dist());
    hook.call({ parse: parseAst, warn }, bad, {}, dist());
    expect(warn).toHaveBeenCalledTimes(1);
    buildStart();
    hook.call({ parse: parseAst, warn }, bad, {}, dist());
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('without a parser in the context (not Rollup) nothing is guessed at: the chunk is left as is', () => {
    const hook = (make({}).rollup as unknown as { renderChunk: RenderChunk }).renderChunk;
    expect(hook.call(undefined, `f(${VERSION})`, {}, dist())).toBeNull();
    expect(hook.call({}, `f(${VERSION})`, {}, dist())).toBeNull();
  });

  it('the map is character-precise (hires), so a replacement does not shift every later column', () => {
    const out = renderChunk(make({}))(`aaaa; f(${VERSION}); bbbb; cccc`, {}, dist());
    // one segment per untouched character, not one per token
    expect(out?.map.mappings.split(',').length).toBeGreaterThanOrEqual(20);
  });

  it('does not touch a longer identifier, a property of the same name, or a chunk without the constant', () => {
    const plugin = make({});
    const code = `x.${VERSION}; ${VERSION}2; $${VERSION}; ${VERSION}$;`;
    expect(renderChunk(plugin)(code, {}, dist())).toBeNull();
    expect(renderChunk(plugin)('const a = 1;', {}, dist())).toBeNull();
  });

  it('resolves from the output file directory when there is no dir', () => {
    const out = renderChunk(make({}))(`f(${VERSION})`, {}, { file: join(web, 'dist', 'a.js') });
    expect(out?.code).toBe('f("2.4.1")');
  });

  it('bakes nothing when disabled, when nothing was found, or when the output directory is unknown', () => {
    expect(renderChunk(make({ disabled: true }))(`f(${VERSION})`, {}, dist())).toBeNull();
    expect(renderChunk(make({}))(`f(${VERSION})`, {}, { dir: join(repo, 'nowhere') })).toBeNull();
    expect(renderChunk(make({}))(`f(${VERSION})`, {}, {})).toBeNull();
  });

  it('the upload carries the value that was baked even if package.json changes mid-build', async () => {
    const plugin = make({});
    renderChunk(plugin)(`f(${VERSION})`, {}, { dir: join(mid, 'dist') });
    writeFileSync(join(mid, 'package.json'), '{"name":"mid","version":"7.7.7"}');
    await rollupWrite(plugin)({ dir: join(mid, 'dist') });
    expect(uploaded().appVersion).toBe('1.0.0');
  });

  it('the upload carries exactly the value that was baked, per output directory', async () => {
    const plugin = make({});
    renderChunk(plugin)(`f(${VERSION})`, {}, dist());
    await rollupWrite(plugin)(dist());
    expect(uploaded().appVersion).toBe('2.4.1');
  });
});
