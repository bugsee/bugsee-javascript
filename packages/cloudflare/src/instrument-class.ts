import {
  type AttributeValue,
  type Bugsee,
  type EdgeExecutionContext,
  runInEdgeContext,
} from '@bugsee/vercel-edge';

// The shared CLASS-instrumentation core (docs/design/edge-runtime.md C2d). Cloudflare's class-based handlers —
// Durable Objects and WorkerEntrypoint — differ from module handlers in ONE load-bearing way: they receive
// their `ctx` (a DurableObjectState / ExecutionContext, both with `waitUntil`) and `env` in the CONSTRUCTOR,
// not per-method (a method is `fetch(request)`, not `fetch(request, env, ctx)`). So this wraps the CLASS: a
// subclass captures the constructor's ctx + env, lazily launches the client from env, and shadows each target
// method with a per-instance wrapper that runs it in a Bugsee context + flushes via that instance's `ctx`.
//
// Subclass + per-instance OWN-property shadowing (NOT a Proxy) is deliberate: the wrapped method calls the
// original with `this` = the REAL instance, so the class's private (`#`) fields keep working (a Proxy `this`
// would throw on private-field access).

/** Build a wrapped method's context attributes from its call args (e.g. the Request for `fetch`). */
export type MethodAttributes = (args: unknown[]) => Record<string, AttributeValue>;

/** A named class method to instrument + how to derive its attributes. */
export interface InstrumentedMethod {
  name: string;
  attributes: MethodAttributes;
}

/** Attributes for an arbitrary RPC method: `{ cloudflare.handler: 'rpc', rpc.method: <name> }`. */
export const rpcMethodAttributes =
  (name: string): MethodAttributes =>
  () => ({ 'cloudflare.handler': 'rpc', 'rpc.method': name });

// Names on a class prototype that are NEVER user RPC methods: the constructor + Cloudflare's RESERVED RPC names
// (`dup` on every RPC type, `connect` on WorkerEntrypoint) which are not RPC-callable.
const NON_RPC_NAMES = new Set(['constructor', 'dup', 'connect']);

/** The arbitrary (RPC) method names on a class prototype: own functions, minus the constructor / reserved names
 *  + the methods already instrumented as lifecycle. */
function rpcMethodNames(prototype: object, alreadyInstrumented: Set<string>): string[] {
  return Object.getOwnPropertyNames(prototype).filter((name) => {
    if (NON_RPC_NAMES.has(name) || alreadyInstrumented.has(name)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    return typeof descriptor?.value === 'function'; // a plain method, not a getter/setter
  });
}

// biome-ignore lint/suspicious/noExplicitAny: the mixin constraint requires `any[]` constructor args so the subclass can `super(...args)` over an arbitrary base — the standard TS class-mixin pattern.
type AnyClass = new (...args: any[]) => object;

/** Instrument a Cloudflare class (Durable Object / WorkerEntrypoint). Returns a subclass that, on construction,
 *  lazily launches the client from `env` (constructor arg 1) and shadows each `methods` entry — plus, when `rpc`
 *  is set, each arbitrary RPC method (`true` = all, or a name list) — with a wrapper that runs the original in a
 *  Bugsee context (its attributes), captures + rethrows, and flushes via the constructor's `ctx` (arg 0).
 *  `awaitFlush` is passed through to the flush strategy — `true` for Durable Objects (their `ctx.waitUntil` is a
 *  no-op, so the flush must be awaited in-request), `false` for WorkerEntrypoint (real, effective `waitUntil`). */
export function instrumentEdgeClass<C extends AnyClass>(
  ensureClient: (env: unknown) => Bugsee,
  TargetClass: C,
  methods: InstrumentedMethod[],
  rpc: boolean | string[] = false,
  awaitFlush = false,
  /** Derives the TENANT key from the constructor's ctx (the Durable Object id). Omitted for
   *  WorkerEntrypoint, which is single-tenant by construction. See
   *  docs/design/cloudflare-tenant-isolation.md §4.1. */
  resolveOwner?: (ctx: unknown) => string | undefined,
  /** Further per-invocation settings forwarded verbatim to `runInEdgeContext`. An object rather than
   *  yet another positional, so the next one does not extend this list again. */
  extra?: { flushTimeoutMs?: number },
): C {
  const specs: InstrumentedMethod[] = [...methods];
  if (rpc !== false) {
    const instrumented = new Set(methods.map((method) => method.name));
    const names =
      rpc === true
        ? rpcMethodNames(TargetClass.prototype, instrumented)
        : rpc.filter((name) => !instrumented.has(name));
    for (const name of names) {
      specs.push({ name, attributes: rpcMethodAttributes(name) });
    }
  }

  // Per-instance invocation state, keyed by the instance rather than stored ON it.
  //
  // The wrappers below live on the PROTOTYPE, so they cannot close over per-instance values; a WeakMap is
  // how each call recovers the client/ctx/owner its instance was constructed with, without adding any own
  // property to the object (and without retaining instances once workerd drops them).
  const instances = new WeakMap<
    object,
    { client: Bugsee; ctx: EdgeExecutionContext | undefined; owner: string | undefined }
  >();

  const Instrumented = class extends TargetClass {
    // biome-ignore lint/suspicious/noExplicitAny: ditto — constructor args are the base's (ctx, env, …).
    constructor(...args: any[]) {
      super(...args);
      instances.set(this, {
        client: ensureClient(args[1]), // env
        ctx: args[0] as EdgeExecutionContext | undefined, // DurableObjectState / ExecutionContext
        // Resolved ONCE per instance: the tenant is a property of the DO, not of an invocation.
        owner: resolveOwner?.(args[0]),
      });
    }
  };

  // The wrappers are installed on the SUBCLASS PROTOTYPE, never as own properties of the instance.
  //
  // This is the whole fix for docs/review/cloudflare.md SEV1 #1. Cloudflare's RPC dispatch exposes methods
  // it finds on the PROTOTYPE; assigning a wrapper to `this[name]` in the constructor shadows the prototype
  // method with an own property, which removes it from the RPC surface entirely. `instrumentRpcMethods` —
  // a documented, advertised opt-in — therefore did not merely fail to instrument, it made the customer's
  // own methods uncallable: `stub.increment()` threw "The RPC receiver does not implement the method".
  // Verified on real workerd, with an uninstrumented method on the same instance as the control.
  for (const { name, attributes } of specs) {
    const original = (TargetClass.prototype as Record<string, unknown>)[name];
    if (typeof original !== 'function') {
      continue; // the method isn't defined on this class (e.g. no `alarm`) → nothing to wrap
    }
    const method = original as (...methodArgs: unknown[]) => unknown;
    Object.defineProperty(Instrumented.prototype, name, {
      // A function expression, not an arrow: `this` must be the instance the call was dispatched on.
      value: function instrumentedMethod(this: object, ...methodArgs: unknown[]): unknown {
        const state = instances.get(this);
        if (state === undefined) {
          return method.apply(this, methodArgs); // never constructed through us → run it untouched
        }
        return runInEdgeContext(
          state.client,
          {
            attributes: attributes(methodArgs),
            ctx: state.ctx,
            awaitFlush,
            ...(state.owner !== undefined ? { owner: state.owner } : {}),
            ...(extra?.flushTimeoutMs !== undefined
              ? { flushTimeoutMs: extra.flushTimeoutMs }
              : {}),
          },
          () => method.apply(this, methodArgs),
        );
      },
      // Matches how a class method is defined: non-enumerable, writable, configurable.
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  return Instrumented as C;
}
