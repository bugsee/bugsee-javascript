// Minimal STRUCTURAL types for the Cloudflare Workers (workerd) handler surface — defined locally so
// @bugsee/cloudflare stays dependency-free (no @cloudflare/workers-types). Only the fields the wrappers read are
// modeled; each is a structural subset of the real runtime type, so a user's fully-typed handler is assignable.

export type Awaitable<T> = T | Promise<T>;

/** The Cloudflare ExecutionContext (the handler's 3rd arg) — carries `waitUntil` to flush after the response. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Cron-trigger controller (the `scheduled` handler's 1st arg). */
export interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

/** Queue-consumer batch (the `queue` handler's 1st arg). */
export interface MessageBatch {
  readonly queue: string;
  readonly messages: ReadonlyArray<unknown>;
}

/** Incoming email (the `email` handler's 1st arg). The from/to addresses are PII — never stamped. */
export interface EmailMessage {
  readonly from: string;
  readonly to: string;
}

/** A Tail event item (the `tail` handler receives an array of these forwarded from other Workers). */
export type TraceItem = unknown;

/** The Cloudflare module-Worker exported handler object: `export default { fetch, scheduled, queue, ... }`. */
export interface ExportedHandler<Env = unknown> {
  fetch?(request: Request, env: Env, ctx: ExecutionContext): Awaitable<Response>;
  scheduled?(controller: ScheduledController, env: Env, ctx: ExecutionContext): Awaitable<void>;
  queue?(batch: MessageBatch, env: Env, ctx: ExecutionContext): Awaitable<void>;
  email?(message: EmailMessage, env: Env, ctx: ExecutionContext): Awaitable<void>;
  tail?(events: ReadonlyArray<TraceItem>, env: Env, ctx: ExecutionContext): Awaitable<void>;
}
