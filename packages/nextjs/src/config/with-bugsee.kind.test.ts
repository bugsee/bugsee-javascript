import { describe, expect, it, vi } from 'vitest';
import type { BugseeNextContext } from './context';
import { withBugsee } from './with-bugsee';

// The compilation kind Next's webpack function is called with decides which policy a plugin instance gets
// (browser maps are public and deleted, server maps are kept), so it is pinned here at the seam.
const created = vi.hoisted(() => [] as string[]);
const contexts = vi.hoisted(() => [] as Array<{ sri?: boolean; forcedMaps?: boolean }>);
vi.mock('./webpack-plugin', () => ({
  createNextWebpackPlugin: (context: { sri?: boolean; forcedMaps?: boolean }, kind: string) => {
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
