import { runInEdgeContext } from '@bugsee/vercel-edge';
import type {
  ExportedHandler,
  MessageBatch,
  ScheduledController,
  TraceItem,
} from './cloudflare-types';
import {
  emailAttributes,
  queueAttributes,
  scheduledAttributes,
  tailAttributes,
} from './handler-attributes';
import { instrumentEdgeClass } from './instrument-class';
import { type BugseeWorkerConfig, createLazyLauncher } from './launch-config';
import { cloudflareRequestAttributes } from './request-cf';

// The unified Cloudflare Workers instrumentation wrapper (docs/design/edge-runtime.md C2). Cloudflare module
// Workers export a handler OBJECT (`export default { fetch, scheduled, queue, email, tail }`); each method is a
// distinct invocation type, and the non-fetch ones have NO incoming Request, so a fetch-only SDK misses cron /
// queue / email / tail entirely. `withBugsee` wraps every PRESENT method so it runs in its own Bugsee context
// (stamped with the trigger's faas.* attributes), captures + rethrows errors, and flushes via that handler's
// `ctx.waitUntil` — all on the shared `runInEdgeContext` core. Absent methods are left untouched.
//
// It ALSO accepts a WorkerEntrypoint CLASS (matching @sentry/cloudflare's `withSentry`): an entrypoint's ctx/env
// come from the constructor (not per-method), so a class is instrumented via the class-mixin core. Durable
// Objects use the separate `instrumentDurableObject` (they're bound separately, not the module's handler).

/** Options for instrumenting a WorkerEntrypoint class. */
export interface WorkerEntrypointInstrumentOptions {
  /** Also instrument arbitrary RPC methods on the entrypoint (default `false`): `true` = all, or a name list. */
  instrumentRpcMethods?: boolean | string[];
}

// biome-ignore lint/suspicious/noExplicitAny: the class-mixin constraint needs `any[]` constructor args (see
// instrument-class.ts) so the returned subclass can `super(...args)` over the user's WorkerEntrypoint base.
type WorkerEntrypointClass = new (...args: any[]) => object;

export function withBugsee<Env, H extends ExportedHandler<Env>>(
  config: BugseeWorkerConfig,
  handler: H,
): H;
export function withBugsee<C extends WorkerEntrypointClass>(
  config: BugseeWorkerConfig,
  entrypoint: C,
  options?: WorkerEntrypointInstrumentOptions,
): C;
export function withBugsee(
  config: BugseeWorkerConfig,
  handlerOrEntrypoint: ExportedHandler | WorkerEntrypointClass,
  options: WorkerEntrypointInstrumentOptions = {},
): unknown {
  const ensureClient = createLazyLauncher(config);

  // A WorkerEntrypoint is a CLASS (typeof 'function') — its ctx/env come from the constructor; a module handler
  // is a plain OBJECT. Instrument the class via the shared class-mixin core (the same fetch/scheduled/queue/
  // email/tail attribute builders), with opt-in arbitrary RPC methods.
  if (typeof handlerOrEntrypoint === 'function') {
    return instrumentEdgeClass(
      ensureClient,
      handlerOrEntrypoint,
      [
        { name: 'fetch', attributes: (args) => cloudflareRequestAttributes(args[0] as Request) },
        {
          name: 'scheduled',
          attributes: (args) => scheduledAttributes(args[0] as ScheduledController),
        },
        { name: 'queue', attributes: (args) => queueAttributes(args[0] as MessageBatch) },
        { name: 'email', attributes: () => emailAttributes() },
        { name: 'tail', attributes: (args) => tailAttributes(args[0] as ReadonlyArray<TraceItem>) },
      ],
      options.instrumentRpcMethods ?? false,
    );
  }

  const handler = handlerOrEntrypoint;
  const wrapped: ExportedHandler = { ...handler };

  const fetchFn = handler.fetch;
  if (fetchFn !== undefined) {
    wrapped.fetch = (request, env, ctx) =>
      runInEdgeContext(
        ensureClient(env),
        { attributes: cloudflareRequestAttributes(request), ctx },
        () => fetchFn(request, env, ctx),
      );
  }
  const scheduledFn = handler.scheduled;
  if (scheduledFn !== undefined) {
    wrapped.scheduled = (controller, env, ctx) =>
      runInEdgeContext(
        ensureClient(env),
        { attributes: scheduledAttributes(controller), ctx },
        () => scheduledFn(controller, env, ctx),
      );
  }
  const queueFn = handler.queue;
  if (queueFn !== undefined) {
    wrapped.queue = (batch, env, ctx) =>
      runInEdgeContext(ensureClient(env), { attributes: queueAttributes(batch), ctx }, () =>
        queueFn(batch, env, ctx),
      );
  }
  const emailFn = handler.email;
  if (emailFn !== undefined) {
    wrapped.email = (message, env, ctx) =>
      runInEdgeContext(ensureClient(env), { attributes: emailAttributes(), ctx }, () =>
        emailFn(message, env, ctx),
      );
  }
  const tailFn = handler.tail;
  if (tailFn !== undefined) {
    wrapped.tail = (events, env, ctx) =>
      runInEdgeContext(ensureClient(env), { attributes: tailAttributes(events), ctx }, () =>
        tailFn(events, env, ctx),
      );
  }
  return wrapped;
}
