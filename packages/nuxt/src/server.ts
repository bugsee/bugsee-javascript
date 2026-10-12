// @bugsee/nuxt — the server (Nitro) surface. Node-only. The U1 Nuxt Module `addServerPlugin`s a Nitro
// runtime plugin that calls `installBugseeNitro(nitroApp, useRuntimeConfig().bugsee)`.

// API parity with the umbrella entries (review R2D-4): the same VALUE surface, thin re-exports of the same functions.
export {
  addReportAttachment,
  BugseeStatus,
  getDefaultNetworkSanitizer,
  getStatus,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
  type ReportAttachmentInput,
  relaunch,
} from '@bugsee/bugsee/node';
export {
  type InstallBugseeNitroOptions,
  installBugseeNitro,
  type NitroAppLike,
  type NitroErrorContext,
  type NitroRenderHtmlContext,
} from './nitro';
