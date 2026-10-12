import {
  getCarrier,
  getCarrierClient,
  getCarrierPendingLaunch,
  RELAUNCH_KEPT_OPTIONS,
  setCarrierRelaunching,
} from './carrier';

export { RELAUNCH_KEPT_OPTIONS };

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

// The carrier already stores ONLY the kept options ({@link RELAUNCH_KEPT_OPTIONS}, filtered in
// `setCarrierLastLaunch`), so a copy of what it holds is exactly what a relaunch carries over.
function keptOptions(previous: unknown): Record<string, unknown> {
  return { ...(previous as Record<string, unknown> | undefined) };
}

/**
 * Stop the running client (if any) and launch again with the same app token (Android/iOS `relaunch`).
 *
 * `launch` is the PLATFORM's launch function (so the umbrella's extensions are re-wired too). Like the
 * mobile SDKs, a relaunch starts from DEFAULTS: `options` are the new Bugsee options, and when omitted
 * every Bugsee option returns to its default. Integration seams and deployment identity ({@link RELAUNCH_KEPT_OPTIONS}:
 * transport, carrier, clock, stores, endpoint, app version...) are kept from the previous launch either way,
 * and an explicit one wins.
 *
 * A launch that is still being built (async platforms) is waited for first, however long it takes, so the
 * relaunch stops THAT client and builds a new one with the new options instead of being answered with the
 * old client. The previous client is then stopped and drained, bounded by `stopTimeoutMs` (default 5 s) so a
 * stuck upload cannot hang the relaunch.
 *
 * `carrierHost` is the carrier host the launch used (injectable for tests). Omitted: the host remembered from
 * the last launch (`launch(token, { carrier })`), else `globalThis`.
 * Rejects when nothing has been launched yet — there is no token to reuse.
 */
export async function relaunchWith<
  Options,
  Client extends { stop(timeout?: number): Promise<boolean> },
>(
  launch: (appToken: string, options: Options) => Client | Promise<Client>,
  options: Options | undefined,
  carrierHost?: object,
  config: { stopTimeoutMs?: number } = {},
): Promise<Client> {
  const timeout = config.stopTimeoutMs ?? DEFAULT_RELAUNCH_STOP_TIMEOUT_MS;
  // Told which host? Use it. Otherwise the host the last launch remembered (`launch(t, { carrier: X })`
  // followed by a plain `relaunch()`), else the real global (R2L-12).
  const globalObj = carrierHost ?? getCarrier().lastHost ?? globalThis;
  const pending = getCarrierPendingLaunch(globalObj);
  if (pending !== undefined) {
    // Wait for the launch in flight for as long as it takes (R2L-8): the bound is for the OLD client's
    // drain. Giving up here either rejected "before launch()" or raced a second build against it.
    await pending.then(undefined, () => undefined);
  }
  const last = getCarrier(globalObj).lastLaunch;
  if (last === undefined) {
    throw new Error('Bugsee.relaunch() called before launch(); there is no app token to reuse');
  }
  // The old client hands what it could not deliver (queued notifications) to the new one while this is set.
  setCarrierRelaunching(true, globalObj);
  try {
    const running = getCarrierClient<Client>(globalObj);
    if (running !== undefined) {
      await bounded(running.stop(timeout), timeout);
    }
    return await launch(last.appToken, { ...keptOptions(last.options), ...options } as Options);
  } finally {
    setCarrierRelaunching(false, globalObj);
  }
}
