import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type AttributeValue,
  type ContextProvider,
  type RequestContext,
  serviceToken,
} from '@bugsee/core';

// The Node request-context binding (design: framework-adapters.md, S4). It realizes the core
// ContextProvider seam over `AsyncLocalStorage`, so each request's context follows its async call-chain
// and stays isolated across concurrent requests on the single SDK instance — the property the
// correlation-by-tagging foundation needs. Node's launch registers ONE store by default; it is a no-op
// (getCurrent → undefined) until a consumer (the Express adapter) opens a context via run().

export interface RequestContextStore extends ContextProvider {
  /** Run `fn` with `context` as the active request context for its (a)synchronous call-chain. */
  run<T>(context: RequestContext, fn: () => T): T;
  /** Set the end-user identity on the active context (no-op when none is open). */
  setUser(user: string): void;
  /** Set a custom attribute on the active context (no-op when none is open). */
  setAttribute(key: string, value: AttributeValue): void;
  /** Set the active W3C trace on the active context (no-op when none is open). */
  setTrace(trace: { traceId: string; spanId: string }): void;
}

/** DI token for the full Node store (adapters resolve it for `run()` + the mutators). */
export const RequestContextStoreToken = serviceToken<RequestContextStore>(
  'node-request-context-store',
);

export function createNodeRequestContextStore(
  storage: AsyncLocalStorage<RequestContext> = new AsyncLocalStorage<RequestContext>(),
): RequestContextStore {
  return {
    getCurrent: () => storage.getStore(),
    run: (context, fn) => storage.run(context, fn),
    setUser(user) {
      const current = storage.getStore();
      if (current !== undefined) {
        current.user = user;
      }
    },
    setAttribute(key, value) {
      const current = storage.getStore();
      if (current === undefined) {
        return;
      }
      if (current.attributes === undefined) {
        current.attributes = {};
      }
      current.attributes[key] = value;
    },
    setTrace(trace) {
      const current = storage.getStore();
      if (current !== undefined) {
        current.trace = trace;
      }
    },
  };
}
