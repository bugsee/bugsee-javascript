// @bugsee/nuxt — the server (Nitro) surface. Node-only. The U1 Nuxt Module `addServerPlugin`s a Nitro
// runtime plugin that calls `installBugseeNitro(nitroApp, useRuntimeConfig().bugsee)`.
export {
  type InstallBugseeNitroOptions,
  installBugseeNitro,
  type NitroAppLike,
  type NitroErrorContext,
  type NitroRenderHtmlContext,
} from './nitro';
