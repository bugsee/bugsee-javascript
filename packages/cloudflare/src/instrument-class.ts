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

  return class extends TargetClass {
    // biome-ignore lint/suspicious/noExplicitAny: ditto — constructor args are the base's (ctx, env, …).
    constructor(...args: any[]) {
      super(...args);
      const client = ensureClient(args[1]); // env
      const ctx = args[0] as EdgeExecutionContext | undefined; // DurableObjectState / ExecutionContext
      for (const { name, attributes } of specs) {
        const original = (this as Record<string, unknown>)[name];
        if (typeof original !== 'function') {
          continue; // the method isn't defined on this class (e.g. no `alarm`) → nothing to wrap
        }
        const method = original as (...methodArgs: unknown[]) => unknown;
        (this as Record<string, unknown>)[name] = (...methodArgs: unknown[]): unknown =>
          runInEdgeContext(client, { attributes: attributes(methodArgs), ctx, awaitFlush }, () =>
            method.apply(this, methodArgs),
          );
      }
    }
  } as C;
}
