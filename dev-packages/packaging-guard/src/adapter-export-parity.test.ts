import * as astroClient from '@bugsee/astro/client';
import * as astroEdge from '@bugsee/astro/edge';
import * as astroServer from '@bugsee/astro/server';
import * as browser from '@bugsee/browser';
import * as umbrellaBrowser from '@bugsee/bugsee';
import * as umbrellaEdge from '@bugsee/bugsee/edge-light';
import * as umbrellaNode from '@bugsee/bugsee/node';
import * as bun from '@bugsee/bun';
import { getDefaultNetworkSanitizer } from '@bugsee/capture';
import * as cloudflare from '@bugsee/cloudflare';
import { addReportAttachment, BugseeStatus, LifecycleEvents } from '@bugsee/core';
import * as deno from '@bugsee/deno';
import * as electronMain from '@bugsee/electron/main';
import * as electronRenderer from '@bugsee/electron/renderer';
import * as nextClient from '@bugsee/nextjs/client';
import * as nextEdge from '@bugsee/nextjs/edge';
import * as nextServer from '@bugsee/nextjs/server';
import * as node from '@bugsee/node';
import * as nuxtClient from '@bugsee/nuxt/client';
import * as nuxtEdge from '@bugsee/nuxt/edge';
import * as nuxtServer from '@bugsee/nuxt/server';
import * as remixClient from '@bugsee/remix/client';
import * as remixServer from '@bugsee/remix/server';
import * as svelteKitClient from '@bugsee/sveltekit/client';
import * as svelteKitEdge from '@bugsee/sveltekit/edge';
import * as svelteKitServer from '@bugsee/sveltekit/server';
import * as vercelEdge from '@bugsee/vercel-edge';
import * as webview from '@bugsee/webview';
import * as webworker from '@bugsee/webworker';
import { describe, expect, it } from 'vitest';

// EXPORT PARITY across the directly imported packages and the framework-adapter subpaths (review R2D-4).
//
// The umbrella entries are pinned in `packages/bugsee/src/export-parity.test.ts`. A user who imports
// `@bugsee/vercel-edge`, `@bugsee/webworker`, `@bugsee/nextjs/server`... directly gets the same product, so the
// same VALUE API must be there too; when it was not, `import { getStatus } from '@bugsee/nextjs/server'` was a
// build error and `LifecycleEvents` an `undefined` at runtime. WHEN YOU ADD A NEW PUBLIC RUNTIME API TO THE
// UMBRELLA: add its name to `PUBLIC_RUNTIME_API` below (and to the umbrella parity test), then this file fails
// for every package that forgot to re-export it. A package that CANNOT offer a name lists it in `EXEMPT` with the
// reason, so an omission is always a decision, never an accident.

const PUBLIC_RUNTIME_API = [
  'addReportAttachment',
  'BugseeStatus',
  'getDefaultNetworkSanitizer',
  'getStatus',
  'LifecycleEvents',
  'relaunch',
] as const;
type ApiName = (typeof PUBLIC_RUNTIME_API)[number];

const ELECTRON_RELAUNCH =
  'Electron: launchMain needs the app ipcMain (not a retained seam) and registers receivers on it; a renderer session is owned by main';
const WEBVIEW =
  'WebView: the process carrier holds only a resolver-only facade, so there is no status to read and no launch to re-run';

const targets: Record<
  string,
  { entry: Record<string, unknown>; exempt?: Partial<Record<ApiName, string>> }
> = {
  '@bugsee/browser': { entry: browser },
  '@bugsee/node': { entry: node },
  '@bugsee/bun': { entry: bun },
  '@bugsee/deno': { entry: deno },
  '@bugsee/vercel-edge': { entry: vercelEdge },
  '@bugsee/cloudflare': { entry: cloudflare },
  '@bugsee/webworker': { entry: webworker },
  '@bugsee/webview': {
    entry: webview,
    exempt: { getStatus: WEBVIEW, relaunch: WEBVIEW },
  },
  '@bugsee/electron/main': { entry: electronMain, exempt: { relaunch: ELECTRON_RELAUNCH } },
  '@bugsee/electron/renderer': { entry: electronRenderer, exempt: { relaunch: ELECTRON_RELAUNCH } },
  '@bugsee/nextjs/server': { entry: nextServer },
  '@bugsee/nextjs/edge': { entry: nextEdge },
  '@bugsee/nextjs/client': { entry: nextClient },
  '@bugsee/remix/server': { entry: remixServer },
  '@bugsee/remix/client': { entry: remixClient },
  '@bugsee/sveltekit/server': { entry: svelteKitServer },
  '@bugsee/sveltekit/edge': { entry: svelteKitEdge },
  '@bugsee/sveltekit/client': { entry: svelteKitClient },
  '@bugsee/astro/server': { entry: astroServer },
  '@bugsee/astro/edge': { entry: astroEdge },
  '@bugsee/astro/client': { entry: astroClient },
  '@bugsee/nuxt/server': { entry: nuxtServer },
  '@bugsee/nuxt/edge': { entry: nuxtEdge },
  '@bugsee/nuxt/client': { entry: nuxtClient },
};

describe('the umbrella still exports every name this guard requires of the adapters', () => {
  for (const [name, entry] of Object.entries({
    browser: umbrellaBrowser,
    node: umbrellaNode,
    'edge-light': umbrellaEdge,
  })) {
    for (const api of PUBLIC_RUNTIME_API) {
      it(`${name} exports ${api}`, () => {
        expect(typeof (entry as Record<string, unknown>)[api]).not.toBe('undefined');
      });
    }
  }
});

describe('directly imported packages and adapter subpaths expose the umbrella value API', () => {
  for (const [pkg, { entry, exempt = {} }] of Object.entries(targets)) {
    for (const api of PUBLIC_RUNTIME_API) {
      if (exempt[api] !== undefined) {
        it(`${pkg} does not export ${api} (${exempt[api]})`, () => {
          expect(api in entry).toBe(false);
        });
        continue;
      }
      it(`${pkg} exports ${api}`, () => {
        expect(entry[api]).toBeDefined();
      });
    }
  }
});

describe('the re-exports are the SAME functions, not look-alikes', () => {
  for (const [pkg, { entry }] of Object.entries(targets)) {
    it(`${pkg} re-exports core's constants and helpers`, () => {
      expect(entry.addReportAttachment).toBe(addReportAttachment);
      expect(entry.BugseeStatus).toBe(BugseeStatus);
      expect(entry.LifecycleEvents).toBe(LifecycleEvents);
      expect(entry.getDefaultNetworkSanitizer).toBe(getDefaultNetworkSanitizer);
    });
  }

  it('getStatus answers Stopped when nothing is launched, wherever it is imported from', () => {
    for (const [pkg, { entry }] of Object.entries(targets)) {
      if (typeof entry.getStatus === 'function') {
        expect([pkg, (entry.getStatus as () => number)()]).toEqual([pkg, BugseeStatus.Stopped]);
      }
    }
  });

  it('relaunch is built per package and rejects before any launch, on every package that offers it', async () => {
    for (const [pkg, { entry }] of Object.entries(targets)) {
      if (typeof entry.relaunch === 'function') {
        await expect((entry.relaunch as () => Promise<unknown>)(), pkg).rejects.toThrow(
          /before launch/,
        );
      }
    }
  });

  it('the umbrella-based adapters keep relaunch off the plain-launch path where their launch differs', () => {
    // Cloudflare / Bun / Deno / Next.js server run a launch that adds defaults on top of the shared one; the
    // package-level `relaunch` must be THEIR relaunch, not the one re-exported from the layer below.
    expect(cloudflare.relaunch).not.toBe(vercelEdge.relaunch);
    expect(bun.relaunch).not.toBe(node.relaunch);
    expect(deno.relaunch).not.toBe(node.relaunch);
    expect(nextServer.relaunch).not.toBe(umbrellaNode.relaunch);
  });
});

// FORBIDDEN names (R5H-4). `relaunchEdge` / `rememberEdgeLaunch` are the SEAM of the meta-framework edge adapters
// (`@bugsee/vercel-edge/relaunch-edge`). They once leaked into `@bugsee/bugsee/edge-light` and `@bugsee/cloudflare`
// through `export *` from the vercel-edge index, where a plain `relaunchEdge()` silently re-ran `launchEdge` and
// dropped the umbrella's extensions / the Cloudflare launch. They must never be public on any package entry.
describe('internal edge relaunch seam names are on NO public entry', () => {
  const FORBIDDEN = ['relaunchEdge', 'rememberEdgeLaunch'] as const;
  const entries: Record<string, Record<string, unknown>> = {
    '@bugsee/bugsee (browser)': umbrellaBrowser,
    '@bugsee/bugsee (node)': umbrellaNode,
    '@bugsee/bugsee/edge-light': umbrellaEdge,
    ...Object.fromEntries(Object.entries(targets).map(([pkg, { entry }]) => [pkg, entry])),
  };
  for (const [pkg, entry] of Object.entries(entries)) {
    for (const name of FORBIDDEN) {
      it(`${pkg} does not export ${name}`, () => {
        expect(name in entry).toBe(false);
      });
    }
  }
});
