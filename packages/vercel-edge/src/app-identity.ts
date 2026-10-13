import type { AppIdentity } from '@bugsee/core';

/** Console warning sink for launch-time diagnostics; never throws into the host. */
export const warnToConsole = (message: string): void => {
  (globalThis as unknown as { console?: { warn?: (m: string) => void } }).console?.warn?.(message);
};

/** On Vercel the deployed commit is the build; the version has no platform-provided equivalent. */
export const vercelAppIdentity = (): AppIdentity | undefined => {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return { build: env?.VERCEL_GIT_COMMIT_SHA };
};
