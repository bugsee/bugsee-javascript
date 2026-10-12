import { getCarrier, getCarrierClient, getCarrierPendingLaunch } from './carrier';

/**
 * The launch options `relaunch()` carries over: INTEGRATION SEAMS (transport, carrier host, time source,
 * stores, runtime handles, the error sink), as opposed to Bugsee options. Everything else is a Bugsee
 * option and goes back to its default on a relaunch without options, as on Android and iOS.
 */
export const RELAUNCH_KEPT_OPTIONS: readonly string[] = [
  'transport',
  'carrier',
  'clock',
  'scheduler',
  'captureStore',
  'bundleStore',
  'capturedDataStore',
  'dataDir',
  'dataRootBase',
  'systemProbe',
  'cpuProfiler',
  'hangWatchdogFactory',
  'systemMetricsSampler',
  'requestContextStore',
  'triggerPipeline',
  'reportSnapshots',
  'fileEncoders',
  'process',
  'window',
  'document',
  'locks',
  'indexedDB',
  'deviceIdEnv',
  'onError',
];

/** How long `relaunch()` waits for the previous client to drain (and for an in-flight launch to finish). */
const DEFAULT_RELAUNCH_STOP_TIMEOUT_MS = 5000;

const globalTimeout = globalThis as unknown as {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** Resolve with `work`, or give up on it after `ms` (never rejects; the timer never keeps a process alive). */
async function bounded(work: Promise<unknown>, ms: number): Promise<void> {
  let handle: unknown;
  const deadline = new Promise<void>((resolve) => {
    handle = globalTimeout.setTimeout(resolve, ms);
    (handle as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([work.then(undefined, () => undefined), deadline]);
  } finally {
    globalTimeout.clearTimeout(handle);
  }
}

function keptOptions(previous: unknown): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  if (typeof previous !== 'object' || previous === null) {
    return kept;
  }
  for (const key of RELAUNCH_KEPT_OPTIONS) {
    if (key in previous) {
      kept[key] = (previous as Record<string, unknown>)[key];
    }
  }
  return kept;
}

/**
 * Stop the running client (if any) and launch again with the same app token (Android/iOS `relaunch`).
 *
 * `launch` is the PLATFORM's launch function (so the umbrella's extensions are re-wired too). Like the
 * mobile SDKs, a relaunch starts from DEFAULTS: `options` are the new Bugsee options, and when omitted
 * every Bugsee option returns to its default. Integration seams ({@link RELAUNCH_KEPT_OPTIONS}: transport,
 * carrier, clock, stores...) are kept from the previous launch either way, and an explicit one wins.
 *
 * A launch that is still being built (async platforms) is waited for first, so the relaunch stops THAT
 * client and builds a new one with the new options instead of being answered with the old client. The
 * previous client is then stopped and drained, bounded by `stopTimeoutMs` (default 5 s) so a stuck upload
 * cannot hang the relaunch.
 *
 * `globalObj` is the carrier host the launch used (injectable for tests; default `globalThis`).
 * Rejects when nothing has been launched yet — there is no token to reuse.
 */
export async function relaunchWith<
  Options,
  Client extends { stop(timeout?: number): Promise<boolean> },
>(
  launch: (appToken: string, options: Options) => Client | Promise<Client>,
  options: Options | undefined,
  globalObj: object = globalThis,
  config: { stopTimeoutMs?: number } = {},
): Promise<Client> {
  const timeout = config.stopTimeoutMs ?? DEFAULT_RELAUNCH_STOP_TIMEOUT_MS;
  const pending = getCarrierPendingLaunch(globalObj);
  if (pending !== undefined) {
    await bounded(pending, timeout);
  }
  const last = getCarrier(globalObj).lastLaunch;
  if (last === undefined) {
    throw new Error('Bugsee.relaunch() called before launch(); there is no app token to reuse');
  }
  const running = getCarrierClient<Client>(globalObj);
  if (running !== undefined) {
    await bounded(running.stop(timeout), timeout);
  }
  return launch(last.appToken, { ...keptOptions(last.options), ...options } as Options);
}
