import { relaunchWith } from '@bugsee/core';
import type { Bugsee } from '@bugsee/node';
import { launchCore } from '@bugsee/node';
import { type BugseeServerLaunchOptions, createServerLaunch } from './server-launch';

// The `bugsee` umbrella launch() for NODE — the batteries-included server entry, selected via the package
// `exports` "node" condition. The composition itself lives in ./server-launch, shared with the bun and deno
// entries; this file is only the binding to @bugsee/node's composition root.

export type BugseeNodeLaunchOptions = BugseeServerLaunchOptions;

export const launch: (appToken: string, options?: BugseeNodeLaunchOptions) => Bugsee =
  createServerLaunch(launchCore);

/** Stop the running client (if any) and launch again with the same token, re-wiring the on-by-default
 *  extensions; `options` replace the previous launch options when given. */
export const relaunch = (options?: BugseeNodeLaunchOptions): Promise<Bugsee> =>
  relaunchWith(launch, options, options?.carrier);
