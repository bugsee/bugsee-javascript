import { getCarrier, getCarrierClient } from './carrier';

/**
 * Stop the running client (if any) and launch again with the same app token (Android/iOS `relaunch`).
 *
 * `launch` is the PLATFORM's launch function (so the umbrella's extensions are re-wired too). `options`
 * REPLACE the previous launch options when given; omitted, the previous ones are reused. The previous
 * client is stopped and fully drained first, so the new client starts with nothing left over.
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
): Promise<Client> {
  const last = getCarrier(globalObj).lastLaunch;
  if (last === undefined) {
    throw new Error('Bugsee.relaunch() called before launch(); there is no app token to reuse');
  }
  await getCarrierClient<Client>(globalObj)?.stop();
  return launch(last.appToken, options ?? (last.options as Options));
}
