// @bugsee/nuxt — the Vue client-plugin core (browser). The U2 Nuxt Module `addPlugin`s a `.client` runtime
// plugin that calls `installBugseeClient(nuxtApp, useRuntimeConfig().public.bugsee)`; it launches the
// batteries-included browser SDK and installs @bugsee/vue's error handler on the Nuxt Vue app.
//
// Browser-only (composes `bugsee` browser + @bugsee/vue) → behind the `@bugsee/nuxt/client` subpath. A pure
// function over a structural `NuxtAppLike` so it is fully unit-testable; the runtime file wraps it with
// `defineNuxtPlugin` (from `nuxt/app`).

import {
  type Bugsee,
  type BugseeLaunchOptionsWithPerformance,
  launch as browserLaunch,
} from '@bugsee/bugsee';
import { installBugseeErrorHandler, type VueAppLike } from '@bugsee/vue';

/** The Nuxt app subset we use — its `vueApp` (a Vue app) (structural; no `nuxt`/`vue` dep). */
export interface NuxtAppLike {
  vueApp: VueAppLike;
}

export interface InstallBugseeClientOptions extends BugseeLaunchOptionsWithPerformance {
  /** The Bugsee app token. */
  appToken: string;
  /** Test/advanced seam: the browser launch. Default the batteries-included `bugsee` browser umbrella launch. */
  launch?: (appToken: string, options: BugseeLaunchOptionsWithPerformance) => Bugsee;
}

/**
 * Launch Bugsee for the Nuxt client (browser) and install `@bugsee/vue`'s error handler on the Nuxt Vue app
 * (which captures Vue errors + reports them to the launched client). Returns the started client. Call from a
 * `.client` Nuxt plugin: `defineNuxtPlugin((nuxtApp) => installBugseeClient(nuxtApp, …))`.
 */
export function installBugseeClient(
  nuxtApp: NuxtAppLike,
  options: InstallBugseeClientOptions,
): Bugsee {
  const { appToken, launch = browserLaunch, ...launchOptions } = options;
  const client = launch(appToken, launchOptions);
  installBugseeErrorHandler(nuxtApp.vueApp);
  return client;
}
