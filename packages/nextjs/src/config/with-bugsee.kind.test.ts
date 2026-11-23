import { describe, expect, it, vi } from 'vitest';
import type { BugseeNextContext } from './context';
import { withBugsee } from './with-bugsee';

// The compilation kind Next's webpack function is called with decides which policy a plugin instance gets
// (browser maps are public and deleted, server maps are kept), so it is pinned here at the seam.
const created = vi.hoisted(() => [] as string[]);
const contexts = vi.hoisted(
  () =>
    [] as Array<{
      sri?: boolean;
      forcedMaps?: boolean;
      browserMaps?: boolean;
      resolved: { appVersion?: string; appBuild?: string };
    }>,
);
vi.mock('./webpack-plugin', () => ({
  createNextWebpackPlugin: (context: (typeof contexts)[number], kind: string) => {
    created.push(kind);
    contexts.push(context);
    return { apply: () => undefined };
  },
}));

const context = {
  resolved: { enabled: true, identityDefines: {} },
  serverSourceMaps: true,
  deleteServerMaps: false,
  say: () => undefined,
} as unknown as BugseeNextContext;

type Webpack = (config: object, options: object) => unknown;
const webpackOf = (config: object = {}): Webpack =>
  (
    withBugsee(
      config,
      {},
      { env: {}, cwd: () => '/app', createContext: () => context, nextVersion: () => '16.4.6' },
    ) as { webpack: Webpack }
  ).webpack;

describe('withBugsee: which compilation a plugin is made for', () => {
  it.each([
    [{ isServer: false }, 'client'],
    [{ isServer: false, nextRuntime: 'edge' }, 'client'],
    [{ isServer: true, nextRuntime: 'nodejs' }, 'server'],
    [{ isServer: true }, 'server'],
    [{ isServer: true, nextRuntime: 'edge' }, 'edge'],
  ])('%j is the %s compilation', (options, kind) => {
    created.length = 0;
    webpackOf()({}, { dev: false, ...options });
    expect(created).toEqual([kind]);
  });
});

describe('withBugsee: the SRI flag reaches the plugins', () => {
  it('marks the context when the app uses experimental.sri, and only then', () => {
    contexts.length = 0;
    webpackOf({ experimental: { sri: { algorithm: 'sha256' } } })(
      {},
      { dev: false, isServer: false },
    );
    webpackOf()({}, { dev: false, isServer: false });
    expect(contexts.map((c) => c.sri === true)).toEqual([true, false]);
  });
});

describe('withBugsee: whether Bugsee turned the browser maps on', () => {
  const forced = (config: object, env: Record<string, string> = {}): boolean | undefined => {
    contexts.length = 0;
    const out = withBugsee(
      config,
      {},
      {
        env,
        cwd: () => '/app',
        createContext: () => context,
        nextVersion: () => '16.4.6',
      },
    ) as { webpack?: Webpack };
    out.webpack?.({}, { dev: false, isServer: false });
    return contexts[0]?.forcedMaps;
  };

  it('is set only when the app said nothing and an upload is possible', () => {
    expect(forced({})).toBe(true);
    expect(forced({ productionBrowserSourceMaps: true })).toBeUndefined();
    expect(forced({ productionBrowserSourceMaps: false })).toBeUndefined();
    expect(forced({ experimental: { sri: {} } })).toBe(true);
  });
});

describe('withBugsee: what the plugins are told about the build', () => {
  const run = (config: object, resolved: object = {}) => {
    contexts.length = 0;
    const ctx = {
      ...context,
      resolved: {
        enabled: true,
        identityDefines: {},
        appVersion: '1.0.0',
        appBuild: '7',
        ...resolved,
      },
    };
    const out = withBugsee(
      config,
      {},
      {
        env: {},
        cwd: () => '/app',
        createContext: () => ctx as never,
        nextVersion: () => '16.4.6',
      },
    ) as { webpack?: Webpack; productionBrowserSourceMaps?: boolean };
    out.webpack?.({}, { dev: false, isServer: false });
    return { out, seen: contexts[0] };
  };

  it('labels the upload with the version and build the APP\u2019s own define bakes into the bundle', () => {
    const { seen } = run({
      compiler: { define: { __BUGSEE_APP_VERSION__: '9.9.9', __BUGSEE_APP_BUILD__: 'b-42' } },
    });
    expect(seen?.resolved).toMatchObject({ appVersion: '9.9.9', appBuild: 'b-42' });
  });

  it('keeps the resolved identity when the app defines nothing, or defines a non-string', () => {
    expect(run({}).seen?.resolved).toMatchObject({ appVersion: '1.0.0', appBuild: '7' });
    expect(
      run({ compiler: { define: { __BUGSEE_APP_VERSION__: 5 } } }).seen?.resolved,
    ).toMatchObject({ appVersion: '1.0.0' });
  });

  it('does not force browser maps on a dry run (it would leave them public: nothing is uploaded or deleted)', () => {
    const { out, seen } = run({}, { dryRun: true });
    expect(out).not.toHaveProperty('productionBrowserSourceMaps');
    expect(seen?.forcedMaps).toBeUndefined();
    expect(
      run({ productionBrowserSourceMaps: true }, { dryRun: true }).out.productionBrowserSourceMaps,
    ).toBe(true);
  });

  it('says whether browser maps are written at all', () => {
    expect(run({}).seen?.browserMaps).toBe(true);
    expect(run({ productionBrowserSourceMaps: true }).seen?.browserMaps).toBe(true);
    expect(run({ productionBrowserSourceMaps: false }).seen?.browserMaps).toBe(false);
    expect(run({}, { dryRun: true }).seen?.browserMaps).toBe(false);
  });
});
