// Wave 2.5 / decision D2 — the SDK must not change how the host process lives and dies.
//
// Two Node semantics drive everything here:
//
//  • Merely REGISTERING an `unhandledRejection` listener disables Node's default disposition, which since
//    Node 15 is to throw and exit 1. A passive listener therefore turns a crashing service into one that
//    keeps running and reports exit 0 — supervisors, CI and health checks all read success
//    (docs/review/node-A-launch.md SEV1 #1, reproduced on Node v24).
//  • Registering an `uncaughtException` listener suppresses Node's default handler, which prints the error
//    and stack to stderr. Nothing re-printed it, so operators lost the first artifact they reach for
//    (SEV1 #4).
//
// A supervisor cannot tell "the SDK is installed" from "the app is healthy", so the SDK has to reproduce
// what would have happened without it.

/**
 * The process listeners Bugsee itself installed.
 *
 * Needed to answer "does the HOST also handle this event?". Node offers only a total count, and Bugsee
 * installs more than one listener of its own (a detection provider that reports, plus launch's policy), so
 * a raw count cannot distinguish the host's handler from ours. Identity can. A WeakSet keeps this from
 * retaining handlers after a client is stopped and collected.
 */
const OWN_HANDLERS = new WeakSet<object>();

/** Any process-like object. Deliberately not a structural interface with only an optional `listeners`
 *  method: TypeScript's weak-type check then rejects `NodeRuntime`, which has no property in common with it.
 *  The method is probed for at runtime instead — and the type is declared here rather than imported from
 *  `detection-providers`, which imports THIS module (a type-only import is still a module cycle). */
export type ListenerSource = object;

/** Record a listener as Bugsee's own, so {@link foreignListenerCount} does not mistake it for the host's. */
export function markOwnHandler<T extends (...args: never[]) => unknown>(handler: T): T {
  OWN_HANDLERS.add(handler);
  return handler;
}

/**
 * How many listeners for `event` belong to the HOST rather than to Bugsee.
 *
 * Returns 0 when the runtime cannot enumerate listeners (an injected test double, or a non-Node
 * process-like). That is the conservative answer: it means "the host has no handler of its own", so the SDK
 * reproduces Node's default disposition — which is what it would have done before this existed.
 */
export function foreignListenerCount(proc: ListenerSource, event: string): number {
  const listeners = (proc as { listeners?: (event: string) => unknown[] }).listeners;
  if (typeof listeners !== 'function') {
    return 0;
  }
  let foreign = 0;
  for (const listener of listeners.call(proc, event)) {
    if (typeof listener === 'function' && !OWN_HANDLERS.has(listener)) {
      foreign += 1;
    }
  }
  return foreign;
}

/**
 * How an unhandled promise rejection is disposed of (decision D2).
 *
 * - `preserve` (DEFAULT) — capture it, then reproduce Node's own outcome: print to stderr and exit 1. The
 *   only setting consistent with Bugsee's binding rule that the SDK never alters host behaviour.
 * - `warn` — capture it and print, but keep the process alive. This is Sentry's default; it is a real
 *   behaviour change versus an uninstrumented process, so it is opt-in here rather than the default.
 * - `none` — do not capture rejections at all. Node's untouched default applies, since no listener exists.
 */
export type UnhandledRejectionMode = 'preserve' | 'warn' | 'none';

/** Print what Node would have printed, so the crash artifact survives the SDK suppressing the default. */
export function printFatal(label: string, value: unknown, write: (text: string) => void): void {
  const detail =
    value instanceof Error ? (value.stack ?? `${value.name}: ${value.message}`) : String(value);
  write(`${label} ${detail}\n`);
}
