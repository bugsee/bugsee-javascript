import { getCarrier, relaunchWith } from '@bugsee/core';
import { type Bugsee, type BugseeEdgeLaunchOptions, launchEdge } from './launch';

/**
 * Stop the running client (if any) and launch again with the same token through THIS package's launch
 * (Android/iOS `relaunch`). Bugsee options return to their defaults, integration seams are kept; `options` are
 * the new Bugsee options. Rejects when nothing was launched yet.
 */
export const relaunch = (options?: BugseeEdgeLaunchOptions): Promise<Bugsee> =>
  relaunchWith(launchEdge, options, options?.carrier);

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
