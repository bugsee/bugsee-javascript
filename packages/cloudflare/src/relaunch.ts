import { type Bugsee, type BugseeEdgeLaunchOptions, relaunchWith } from '@bugsee/vercel-edge';
import { launch } from './launch';

/**
 * Stop the running client (if any) and launch again with the same token through the CLOUDFLARE `launch` (so
 * the `workers` platform identity, the AsyncLocalStorage and the tenant partitioning are re-applied), not the
 * plain edge one the `@bugsee/vercel-edge` re-export would run. Bugsee options return to their defaults;
 * integration seams are kept. Rejects when nothing was launched yet.
 */
export const relaunch = (options?: BugseeEdgeLaunchOptions): Promise<Bugsee> =>
  relaunchWith(launch, options, options?.carrier);
