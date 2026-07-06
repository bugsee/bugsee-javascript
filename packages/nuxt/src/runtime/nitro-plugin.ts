// @bugsee/nuxt — the shipped Nitro runtime plugin. The U1 Nuxt Module `addServerPlugin`s this file
// (`resolver.resolve('./runtime/nitro-plugin')`); Nitro runs it at server startup. It reads the private
// `bugsee` runtime config (the module writes it from the module options' `appToken` + `server` bag) and
// hands it to our tested server core `installBugseeNitro`, which launches the node SDK + wires Nitro's
// `error` hook.
//
// Uses REAL-package auto-imports (`defineNitroPlugin`/`useRuntimeConfig` from `nitropack/runtime`, not the
// virtual `#imports`) so it builds with tsup (externalized) and is executably unit-testable. The server
// core value comes from the self-subpath `@bugsee/nuxt/server` (external in both build formats), never a
// relative import, so the node-only core is not inlined into other bundles (see #172).
import type { InstallBugseeNitroOptions } from '@bugsee/nuxt/server';
import { installBugseeNitro } from '@bugsee/nuxt/server';
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime';

export default defineNitroPlugin((nitroApp) => {
  const options = useRuntimeConfig().bugsee as InstallBugseeNitroOptions;
  installBugseeNitro(nitroApp as never, options);
});
