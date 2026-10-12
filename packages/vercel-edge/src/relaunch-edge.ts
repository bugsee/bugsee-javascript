// The edge-ENTRY relaunch seam (R4H-4), deliberately NOT exported from the package index (R5H-4): the umbrella's
// `edge-light` entry and `@bugsee/cloudflare` `export *` the index, and a plain `relaunchEdge()` there would
// silently re-run `launchEdge`, dropping the umbrella's extensions / the Cloudflare launch. Only the
// meta-framework edge adapters (`@bugsee/{sveltekit,astro,nuxt}/edge`) import this subpath
// (`@bugsee/vercel-edge/relaunch-edge`).
import { getCarrier, relaunchWith } from '@bugsee/core';
import { type Bugsee, type BugseeEdgeLaunchOptions, launchEdge } from './launch';

/** An edge launch function: `launchEdge`, or a platform's own (e.g. Cloudflare's). */
export type EdgeLaunch = (appToken: string, options: BugseeEdgeLaunchOptions) => Bugsee;

/**
 * Remember the launch function an edge entry was installed with on its carrier (`carrier` default
 * `globalThis`), so {@link relaunchEdge} re-runs the same seam by default (R4H-4).
 */
export function rememberEdgeLaunch(launch: EdgeLaunch, carrier?: object): void {
  getCarrier(carrier ?? globalThis).edgeLaunch = launch;
}

/**
 * `relaunch` for the edge entries that take a `launch` seam. Which launch runs: the explicit `options.launch`;
 * else the one {@link rememberEdgeLaunch} stored when the entry was installed (so a custom launch, e.g.
 * Cloudflare's, is re-run rather than silently replaced by `launchEdge`); else `launchEdge`. Whichever runs
 * becomes the remembered one. The seam is not a launch option and is not passed on.
 */
export async function relaunchEdge(
  options: BugseeEdgeLaunchOptions & { launch?: EdgeLaunch } = {},
): Promise<Bugsee> {
  const { launch, ...launchOptions } = options;
  // The host relaunchWith will use: told one, else the host the last launch remembered, else the global.
  const host = launchOptions.carrier ?? getCarrier().lastHost ?? globalThis;
  const chosen = launch ?? (getCarrier(host).edgeLaunch as EdgeLaunch | undefined) ?? launchEdge;
  const client = await relaunchWith(chosen, launchOptions, launchOptions.carrier);
  rememberEdgeLaunch(chosen, host); // only a launch that came up is worth remembering
  return client;
}
