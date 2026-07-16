import type { AttributeValue } from '@bugsee/vercel-edge';
import { instrumentEdgeClass } from './instrument-class';
import { type BugseeWorkerConfig, createLazyLauncher } from './launch-config';
import { cloudflareRequestAttributes } from './request-cf';

// Durable Object instrumentation (docs/design/edge-runtime.md C2d — follows @sentry/cloudflare's
// `instrumentDurableObjectWithSentry`). A DO is a CLASS bound separately (not a module handler), and it receives
// its `ctx` (a DurableObjectState, which has `waitUntil`) + `env` in the CONSTRUCTOR — so it can't use the
// handler-object `withBugsee`. This wraps the DO class so its lifecycle methods (`fetch` + `alarm`) each run in
// a Bugsee context + flush via the constructor's `ctx`; arbitrary RPC methods are opt-in (default off, matching
// Sentry's `instrumentPrototypeMethods`).

const handlerAttributes = (handler: string): Record<string, AttributeValue> => ({
  'cloudflare.handler': handler,
});
const alarmAttributes = (): Record<string, AttributeValue> => ({
  'faas.trigger': 'timer',
  'cloudflare.handler': 'durable_object.alarm',
});

export interface DurableObjectInstrumentOptions {
  /** Also instrument arbitrary RPC / prototype methods (default `false`): `true` = all, or a list of names. */
  instrumentRpcMethods?: boolean | string[];
}

// biome-ignore lint/suspicious/noExplicitAny: the class-mixin constraint requires `any[]` constructor args (see instrument-class.ts) so the returned subclass can `super(...args)` over the user's DO base.
type DurableObjectClass = new (...args: any[]) => object;

/** Instrument a Durable Object class — wrap the EXPORT, not just the impl:
 *  `export const MyDO = instrumentDurableObject(env => env.BUGSEE_APP_TOKEN, MyDOClass)`. Its `fetch` (with http +
 *  request.cf attrs) and `alarm` run in a Bugsee context + capture + flush via the DO's `ctx.waitUntil`. Pass
 *  `{ instrumentRpcMethods: true | [names] }` to also instrument arbitrary RPC methods. The client launches
 *  lazily from the constructor `env` (a Worker secret), cached per-isolate. */
export function instrumentDurableObject<C extends DurableObjectClass>(
  config: BugseeWorkerConfig,
  durableObjectClass: C,
  options: DurableObjectInstrumentOptions = {},
): C {
  const ensureClient = createLazyLauncher(config);
  return instrumentEdgeClass(
    ensureClient,
    durableObjectClass,
    [
      { name: 'fetch', attributes: (args) => cloudflareRequestAttributes(args[0] as Request) },
      { name: 'alarm', attributes: alarmAttributes },
      // WebSocket Hibernation handlers — the hot path for real-time DOs; capture errors there by default.
      {
        name: 'webSocketMessage',
        attributes: () => handlerAttributes('durable_object.websocket_message'),
      },
      {
        name: 'webSocketClose',
        attributes: () => handlerAttributes('durable_object.websocket_close'),
      },
      {
        name: 'webSocketError',
        attributes: () => handlerAttributes('durable_object.websocket_error'),
      },
    ],
    options.instrumentRpcMethods ?? false,
    true, // a DO's ctx.waitUntil is a no-op → await the flush in-request (see edge-context.ts awaitFlush)
  );
}
