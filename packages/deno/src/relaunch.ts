import { relaunchWith } from '@bugsee/core';
import type { Bugsee, BugseeLaunchOptions } from '@bugsee/node';
import { launch } from './launch';

/** Stop the running client (if any) and launch again with the same token through THIS package's launch, so the
 *  Deno system probe and the runtime gates are re-applied (the re-exported @bugsee/node `relaunch` would run the
 *  plain node launch). Bugsee options return to their defaults; integration seams are kept. */
export const relaunch = (options?: BugseeLaunchOptions): Promise<Bugsee> =>
  relaunchWith(launch, options, options?.carrier);
