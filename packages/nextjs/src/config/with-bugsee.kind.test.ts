import { describe, expect, it, vi } from 'vitest';
import type { BugseeNextContext } from './context';
import { withBugsee } from './with-bugsee';

// The compilation kind Next's webpack function is called with decides which policy a plugin instance gets
// (browser maps are public and deleted, server maps are kept), so it is pinned here at the seam.
const created = vi.hoisted(() => [] as string[]);
vi.mock('./webpack-plugin', () => ({
  createNextWebpackPlugin: (_context: unknown, kind: string) => {
    created.push(kind);
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
const webpackOf = (): Webpack =>
  (
    withBugsee(
      {},
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
