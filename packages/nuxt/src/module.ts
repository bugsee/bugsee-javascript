// @bugsee/nuxt — the Nuxt Module (the package `.` entry). Users add `modules: ['@bugsee/nuxt']` +
// `bugsee: { appToken }` to `nuxt.config.ts`; Nuxt calls this module at BUILD time. It:
//   1. writes the config into Nuxt's runtimeConfig — the `client` bag (+ appToken) into the PUBLIC config
//      (shipped to the browser) and the `server` bag (+ appToken) into the private config (server-only);
//   2. registers the browser plugin as a client-mode template (generated so we avoid a heavy full-`nuxt`
//      dep just for `defineNuxtPlugin`) → it runs `installBugseeClient` (browser session + @bugsee/vue);
//   3. registers the shipped Nitro server plugin (`./runtime/nitro-plugin`) → `installBugseeNitro` (node
//      session + Nitro `error` hook).
// Build-time only: imports `@nuxt/kit` + TYPE-only option shapes — no `bugsee`/`bugsee/node` runtime pulled
// into the module bundle (the client/server cores are referenced by template string / resolved path).
import { addPluginTemplate, addServerPlugin, createResolver, defineNuxtModule } from '@nuxt/kit';
import type { InstallBugseeClientOptions } from './client';
import type { InstallBugseeNitroOptions } from './nitro';

/** `@bugsee/nuxt` module options (from `nuxt.config.ts` `bugsee: {…}`). */
export interface ModuleOptions {
  /** The Bugsee app token. */
  appToken: string;
  /** Extra browser (client) launch options — merged into the PUBLIC runtime config. */
  client?: Omit<Partial<InstallBugseeClientOptions>, 'appToken' | 'launch'>;
  /** Extra Nitro (server) launch options — merged into the private runtime config. */
  server?: Omit<Partial<InstallBugseeNitroOptions>, 'appToken' | 'launch'>;
}

/** The Nuxt object subset the module mutates + reads (structural — avoids a `@nuxt/schema` dep). */
export interface NuxtLike {
  options: {
    runtimeConfig: {
      bugsee?: unknown;
      public: { bugsee?: unknown } & Record<string, unknown>;
    } & Record<string, unknown>;
    /** The Nitro config — its `preset` chooses node vs edge server delivery. */
    nitro?: { preset?: string };
  };
  /**
   * Nuxt's hook bus. `nitro:init` is the first point at which the RESOLVED Nitro preset exists (Wave 4.4);
   * optional so a structural Nuxt without it still works, just without the late correction.
   */
  hook?: (name: string, fn: (nitro: NitroLike) => void) => void;
}

/** The slice of Nitro the preset correction needs: the resolved preset and the plugin list to amend. */
export interface NitroLike {
  options: { preset?: string; plugins: string[] };
}

/** Is the resolved Nitro `preset` an EDGE target (Vercel Edge / Cloudflare / Netlify Edge / workerd)? Those
 *  run the edge SDK, not `bugsee/node`. Node presets (`node-server`, `vercel`, `netlify`, …) return false. */
function isEdgePreset(preset: string | undefined): boolean {
  if (typeof preset !== 'string') return false;
  const p = preset.toLowerCase();
  return p.includes('edge') || p.includes('cloudflare') || p.includes('worker');
}

/** A runtime-config slot narrowed to a plain object (Nuxt may leave it `undefined` until set). */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The generated browser plugin's source. Runs on the client only; installs the browser SDK + Vue error
 *  handler from the PUBLIC runtime config. Kept a pure generator so its output is unit-asserted. */
export function clientPluginContent(): string {
  return `import { defineNuxtPlugin, useRuntimeConfig } from '#imports';
import { installBugseeClient } from '@bugsee/nuxt/client';

export default defineNuxtPlugin((nuxtApp) => {
  installBugseeClient(nuxtApp, useRuntimeConfig().public.bugsee);
});
`;
}

/** The module setup — a pure function over `@nuxt/kit` helpers + a structural Nuxt, so it is fully
 *  unit-testable. Exported and wired as the module's `setup`. */
export function setupBugseeModule(options: ModuleOptions, nuxt: NuxtLike): void {
  const { appToken, client, server } = options;
  const { runtimeConfig } = nuxt.options;
  // Client config is PUBLIC (exposed to the browser bundle); server config stays private. Merge our values
  // UNDER any `runtimeConfig` the user set directly in nuxt.config (+ env overrides), matching Nuxt's `defu`
  // convention — an explicit user/env value wins over our module default.
  runtimeConfig.public.bugsee = { appToken, ...client, ...asRecord(runtimeConfig.public.bugsee) };
  runtimeConfig.bugsee = { appToken, ...server, ...asRecord(runtimeConfig.bugsee) };

  // Browser plugin — a generated client-mode template (`#imports` resolved by Nuxt at the app's build).
  addPluginTemplate({
    filename: 'bugsee-client.mjs',
    mode: 'client',
    getContents: clientPluginContent,
  });

  // Nitro server plugin — the shipped runtime file, resolved relative to this module. On an edge preset we
  // ship the EDGE plugin (launches the edge SDK, not `bugsee/node`) so only the right SDK is bundled.
  const resolver = createResolver(import.meta.url);
  const nodePlugin = resolver.resolve('./runtime/nitro-plugin');
  const edgePlugin = resolver.resolve('./runtime/nitro-plugin.edge');

  // Registered here from whatever the preset looks like NOW, which is only populated when the user wrote
  // `nitro: { preset }` or passed an explicit override.
  addServerPlugin(isEdgePreset(nuxt.options.nitro?.preset) ? edgePlugin : nodePlugin);

  // …and CORRECTED once the preset is actually resolved (Wave 4.4). Nitro auto-detects it inside
  // `createNitro()`, long after modules run — the zero-config path Nuxt's own deployment docs advertise —
  // so on Cloudflare Pages/Workers the check above saw `undefined`, concluded "not edge", and shipped
  // `@bugsee/bugsee/node` into a workerd bundle: fs storage, the worker-thread ANR watchdog and
  // `process.uptime()`, none of which exist there. Measured on a real build: setup sees `undefined`,
  // `nitro:init` sees `"cloudflare-pages"`.
  //
  // A correction rather than a replacement, so a Nuxt without the hook — or one whose `nitro:init` never
  // fires — is left exactly as it was before, never with no server plugin at all.
  nuxt.hook?.('nitro:init', (nitro) => {
    const wantEdge = isEdgePreset(nitro.options.preset);
    const want = wantEdge ? edgePlugin : nodePlugin;
    const drop = wantEdge ? nodePlugin : edgePlugin;
    const plugins = nitro.options.plugins;
    const stale = plugins.indexOf(drop);
    if (stale !== -1) {
      plugins.splice(stale, 1);
    }
    if (!plugins.includes(want)) {
      plugins.push(want);
    }
  });
}

export default defineNuxtModule<ModuleOptions>({
  meta: { name: '@bugsee/nuxt', configKey: 'bugsee' },
  setup: setupBugseeModule as unknown as (options: ModuleOptions, nuxt: unknown) => void,
});
