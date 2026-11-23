import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BugseeNextContext } from './context';
import { versionAtLeast, type WithBugseeDeps, withBugsee } from './with-bugsee';

vi.mock('./post-build', () => ({ runPostBuild: vi.fn(async () => undefined) }));

import { runPostBuild } from './post-build';

function context(
  overrides: Partial<BugseeNextContext['resolved']> = {},
  extra: Partial<BugseeNextContext> = {},
): BugseeNextContext {
  return {
    resolved: {
      enabled: true,
      identityDefines: { __BUGSEE_APP_VERSION__: '"1.0.0"', __BUGSEE_APP_BUILD__: '"7"' },
      ...overrides,
    } as BugseeNextContext['resolved'],
    serverSourceMaps: true,
    deleteServerMaps: false,
    say: vi.fn(),
    ...extra,
  };
}

function deps(
  ctx = context(),
  over: WithBugseeDeps = {},
): WithBugseeDeps & { ctx: BugseeNextContext } {
  return {
    ctx,
    cwd: () => '/app',
    env: {},
    nextVersion: () => '16.4.6',
    createContext: vi.fn(() => ctx),
    ...over,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: a Next config under test is open-ended.
type Obj = Record<string, any>;
const apply = (config: Obj, d: WithBugseeDeps, options = {}): Obj =>
  withBugsee(config, options, d) as Obj;

describe('versionAtLeast', () => {
  it.each([
    ['16.4.6', true],
    ['15.4.1', true],
    ['15.4.2', true],
    ['15.5.0', true],
    ['15.4.0', false],
    ['15.3.9', false],
    ['14.9.9', false],
    ['15.4.1-canary.3', true],
    ['not-a-version', true],
  ])('%s -> %s', (version, expected) => {
    expect(versionAtLeast(version, [15, 4, 1])).toBe(expected);
  });
});

describe('withBugsee: composition', () => {
  it('returns the config untouched when disabled', () => {
    const config = { a: 1 };
    expect(withBugsee(config, { disabled: true })).toBe(config);
  });

  it('defaults to an empty config', () => {
    expect(withBugsee(undefined, {}, deps()) as Obj).toMatchObject({
      productionBrowserSourceMaps: true,
    });
  });

  it('keeps every key of the app’s config', () => {
    const out = apply({ reactStrictMode: true, images: { x: 1 } }, deps());
    expect(out).toMatchObject({ reactStrictMode: true, images: { x: 1 } });
  });

  it('turns browser source maps on only when the app said nothing', () => {
    expect(apply({}, deps()).productionBrowserSourceMaps).toBe(true);
    expect(apply({ productionBrowserSourceMaps: false }, deps()).productionBrowserSourceMaps).toBe(
      false,
    );
    expect(apply({ productionBrowserSourceMaps: true }, deps()).productionBrowserSourceMaps).toBe(
      true,
    );
  });

  it('does not change what Next emits when there is no token (nothing would be uploaded or removed)', () => {
    const out = apply({}, deps(context({ enabled: false })));
    expect(out.productionBrowserSourceMaps).toBeUndefined();
    expect(out.webpack).toBeUndefined();
    expect(out.compiler?.runAfterProductionCompile).toBeUndefined();
  });

  it('bakes the identity into compiler.define, the app’s own constants winning, never into defineServer', () => {
    const out = apply(
      {
        compiler: { define: { __BUGSEE_APP_VERSION__: '"mine"', OTHER: '1' }, removeConsole: true },
      },
      deps(),
    );
    expect(out.compiler.define).toEqual({
      __BUGSEE_APP_VERSION__: '"mine"',
      __BUGSEE_APP_BUILD__: '"7"',
      OTHER: '1',
    });
    expect(out.compiler.defineServer).toBeUndefined();
    expect(out.compiler.removeConsole).toBe(true);
  });

  it('bakes the identity even without a token, but adds no define when none was found', () => {
    expect(apply({}, deps(context({ enabled: false }))).compiler.define).toMatchObject({
      __BUGSEE_APP_VERSION__: '"1.0.0"',
    });
    expect(apply({}, deps(context({ identityDefines: {} }))).compiler).toBeUndefined();
  });
});

describe('withBugsee: phases and shapes', () => {
  it('leaves a function config alone for every phase except the production build', async () => {
    const d = deps();
    const fn = withBugsee(() => ({ a: 1 }), {}, d) as unknown as (
      p: string,
      c: Obj,
    ) => Promise<Obj>;
    for (const phase of ['phase-development-server', 'phase-production-server', 'phase-export']) {
      expect(await fn(phase, { defaultConfig: {} })).toEqual({ a: 1 });
    }
    expect(d.createContext).not.toHaveBeenCalled();
    const built = await fn('phase-production-build', { defaultConfig: {} });
    expect(built.productionBrowserSourceMaps).toBe(true);
  });

  it('awaits an async function config and passes it the phase arguments', async () => {
    const user = vi.fn(async () => ({ a: 1 }));
    const fn = withBugsee(user, {}, deps()) as unknown as (p: string, c: Obj) => Promise<Obj>;
    const out = await fn('phase-production-build', { defaultConfig: { d: 1 } });
    expect(user).toHaveBeenCalledWith('phase-production-build', { defaultConfig: { d: 1 } });
    expect(out.a).toBe(1);
  });

  it('extends a config that is a promise', async () => {
    const out = (await withBugsee(Promise.resolve({ a: 1 }), {}, deps())) as Obj;
    expect(out).toMatchObject({ a: 1, productionBrowserSourceMaps: true });
  });

  it('resolves the context from the working directory, with the injected environment', () => {
    const d = deps(context(), { cwd: () => '/work/app', env: { X: '1' } });
    apply({}, d, { appToken: 't' });
    expect(d.createContext).toHaveBeenCalledWith({ appToken: 't' }, '/work/app', {
      env: { X: '1' },
    });
  });

  it('uses the process cwd and environment when none are injected', () => {
    const create = vi.fn(() => context());
    withBugsee({}, {}, { createContext: create, nextVersion: () => '16.0.0' });
    expect(create).toHaveBeenCalledWith({}, process.cwd(), { env: process.env });
  });
});

describe('withBugsee: the webpack function', () => {
  const nextArgs = (over: Obj = {}) => ({
    dev: false,
    isServer: false,
    nextRuntime: undefined,
    ...over,
  });

  it('appends one Bugsee plugin per compilation and keeps the app’s plugins', () => {
    const out = apply({}, deps());
    const result = out.webpack({ plugins: ['mine'], devtool: 'source-map' }, nextArgs());
    expect(result.plugins[0]).toBe('mine');
    expect(result.plugins).toHaveLength(2);
    expect(typeof result.plugins[1].apply).toBe('function');
  });

  it('creates the plugin list when the config has none', () => {
    const result = apply({}, deps()).webpack({}, nextArgs());
    expect(result.plugins).toHaveLength(1);
  });

  it('does nothing for next dev', () => {
    const config = { plugins: ['mine'] };
    const result = apply({}, deps()).webpack(config, nextArgs({ dev: true }));
    expect(result.plugins).toEqual(['mine']);
    expect(result.devtool).toBeUndefined();
  });

  it('gives server and edge compilations a source-map devtool only when the app left it unset', () => {
    const out = apply({}, deps());
    expect(out.webpack({}, nextArgs({ isServer: true, nextRuntime: 'nodejs' })).devtool).toBe(
      'source-map',
    );
    expect(out.webpack({}, nextArgs({ isServer: true, nextRuntime: 'edge' })).devtool).toBe(
      'source-map',
    );
    expect(
      out.webpack({ devtool: 'hidden-source-map' }, nextArgs({ isServer: true })).devtool,
    ).toBe('hidden-source-map');
    // The browser's devtool is Next's own business (productionBrowserSourceMaps).
    expect(out.webpack({}, nextArgs()).devtool).toBeUndefined();
  });

  it('leaves server devtool alone when server maps are off', () => {
    const out = apply({}, deps(context({}, { serverSourceMaps: false })));
    expect(out.webpack({}, nextArgs({ isServer: true })).devtool).toBeUndefined();
  });

  it('runs the app’s own webpack function first, on the same config, and uses what it returns', () => {
    const user = vi.fn((config: Obj) => ({ ...config, custom: true }));
    const out = apply({ webpack: user }, deps());
    const base = { plugins: [] };
    const args = nextArgs();
    const result = out.webpack(base, args);
    expect(user).toHaveBeenCalledWith(base, args);
    expect(result.custom).toBe(true);
    expect(result.plugins).toHaveLength(1);
  });

  it('uses the original config when the app’s webpack function returns nothing', () => {
    const out = apply({ webpack: () => undefined }, deps());
    expect(out.webpack({ plugins: [] }, nextArgs()).plugins).toHaveLength(1);
  });

  it('supports an async app webpack function', async () => {
    const out = apply({ webpack: async (c: Obj) => ({ ...c, late: true }) }, deps());
    const result = await out.webpack({}, nextArgs());
    expect(result.late).toBe(true);
    expect(result.plugins).toHaveLength(1);
  });
});

describe('withBugsee: Turbopack', () => {
  const turbo = (over: Partial<WithBugseeDeps> = {}, ctx = context()) =>
    deps(ctx, { env: { TURBOPACK: '1' }, ...over });

  it('adds no webpack function to a Turbopack build (Next 16 refuses one), and leaves the app’s own', () => {
    expect(apply({}, turbo()).webpack).toBeUndefined();
    const mine = () => undefined;
    expect(apply({ webpack: mine }, turbo()).webpack).toBe(mine);
  });

  it('installs the post-build hook only for a Turbopack build', () => {
    expect(apply({}, deps()).compiler?.runAfterProductionCompile).toBeUndefined();
    expect(typeof apply({}, turbo()).compiler.runAfterProductionCompile).toBe('function');
  });

  it('runs the app’s own hook first, then the upload, with the same metadata', async () => {
    const order: string[] = [];
    (runPostBuild as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('bugsee');
    });
    const user = vi.fn(async () => {
      order.push('user');
    });
    const d = turbo();
    const out = apply({ compiler: { runAfterProductionCompile: user, removeConsole: true } }, d);
    const metadata = { projectDir: '/app', distDir: '/app/.next' };
    await out.compiler.runAfterProductionCompile(metadata);
    expect(order).toEqual(['user', 'bugsee']);
    expect(user).toHaveBeenCalledWith(metadata);
    expect(runPostBuild).toHaveBeenCalledWith(d.ctx, metadata);
    // The rest of `compiler`, and the baked identity, survive next to the hook.
    expect(out.compiler.removeConsole).toBe(true);
    expect(out.compiler.define.__BUGSEE_APP_VERSION__).toBe('"1.0.0"');
  });

  it('works when the app has no hook of its own', async () => {
    const out = apply({}, turbo());
    await expect(
      out.compiler.runAfterProductionCompile({ projectDir: '/a', distDir: '/a/.next' }),
    ).resolves.toBeUndefined();
  });

  it('keeps the hook next to an app compiler block when there is no identity to bake', () => {
    const out = apply(
      { compiler: { removeConsole: true } },
      turbo({}, context({ identityDefines: {} })),
    );
    expect(out.compiler.removeConsole).toBe(true);
    expect(typeof out.compiler.runAfterProductionCompile).toBe('function');
  });

  it('refuses to promise an upload on a Next that has no hook, and says so', () => {
    const ctx = context();
    const out = apply({}, turbo({ nextVersion: () => '15.3.0' }, ctx));
    expect(out.compiler?.runAfterProductionCompile).toBeUndefined();
    expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('15.4.1'));
  });

  it('draws the line at 15.4.1: the hook is installed from there, not before', () => {
    const hooked = (version: string): boolean =>
      typeof apply({}, turbo({ nextVersion: () => version })).compiler
        ?.runAfterProductionCompile === 'function';
    expect(hooked('15.4.0')).toBe(false);
    expect(hooked('15.4.1')).toBe(true);
    expect(hooked('15.5.28')).toBe(true);
    expect(hooked('16.4.6')).toBe(true);
  });

  it('installs the hook when the Next version cannot be determined', () => {
    const out = apply({}, turbo({ nextVersion: () => undefined }));
    expect(typeof out.compiler.runAfterProductionCompile).toBe('function');
  });

  it('reads the installed Next version from the project when none is injected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-nextver-'));
    try {
      mkdirSync(join(dir, 'node_modules', 'next'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"name":"app"}');
      writeFileSync(
        join(dir, 'node_modules', 'next', 'package.json'),
        '{"name":"next","version":"15.3.0"}',
      );
      const ctx = context();
      const out = withBugsee(
        {},
        {},
        { env: { TURBOPACK: '1' }, cwd: () => dir, createContext: () => ctx },
      ) as Obj;
      expect(out.compiler?.runAfterProductionCompile).toBeUndefined();
      expect(ctx.say).toHaveBeenCalledWith(expect.stringContaining('Next 15.3.0'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an unreadable next manifest as an unknown version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-nonext-'));
    try {
      // `next` is there but its manifest cannot be read: the version is unknown, never an error.
      mkdirSync(join(dir, 'node_modules', 'next'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', 'next', 'package.json'), '{not json');
      const ctx = context();
      const out = withBugsee(
        {},
        {},
        { env: { TURBOPACK: '1' }, cwd: () => dir, createContext: () => ctx },
      ) as Obj;
      expect(typeof out.compiler.runAfterProductionCompile).toBe('function');
      expect(ctx.say).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
