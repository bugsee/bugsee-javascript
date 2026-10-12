import { relaunchWith } from '@bugsee/core';
import { type Bugsee, type BugseeEdgeLaunchOptions, launchEdge } from './launch';

/**
 * Stop the running client (if any) and launch again with the same token through THIS package's launch
 * (Android/iOS `relaunch`). Bugsee options return to their defaults, integration seams are kept; `options` are
 * the new Bugsee options. Rejects when nothing was launched yet.
 */
export const relaunch = (options?: BugseeEdgeLaunchOptions): Promise<Bugsee> =>
  relaunchWith(launchEdge, options, options?.carrier);
