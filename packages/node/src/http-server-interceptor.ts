import http from 'node:http';
import https from 'node:https';
import type { BugseeClient } from '@bugsee/core';
import { runServerRequest, type ServerInstrumentOptions } from './server-instrument';

// Incoming-server auto-instrumentation for node:http (design: docs/design/incoming-server-instrumentation.md
// §5.2, decisions D2/D11/D12). Patches `http.Server.prototype.emit` AND `https.Server.prototype.emit` (https
// inherits emit via the tls/net chain, NOT via http.Server.prototype, so each is patched separately) to
// bracket the `'request'` event: it opens the per-request context + an http.server transaction via the
// shared `runServerRequest` core (run-scoped), wires finish on the response, and passes the dispatch
// straight through. It is the OPT-IN, INSTALL-DRIVEN companion to the outbound node:http capture source —
// a server patch has no "subscriber", so it is NOT an InterceptorBase and is driven by explicit
// install()/uninstall() (launch/stop, slice 3). Restores the prototype by DELETE (the original `emit` is
// inherited from EventEmitter.prototype, so reassigning would leave a residual own-property that alters the
// prototype shape — "interceptors must not alter app behavior"). Self-isolates the SDK's own inbound
// traffic (x-bugsee-internal). Captures NO handled errors (a framework swallows them before node:http) and
// NO headers/bodies — context + APM only.

type EmitFn = (this: unknown, event: string | symbol, ...args: unknown[]) => boolean;
interface ProtoWithEmit {
  emit: EmitFn;
}
interface ServerCtor {
  prototype: ProtoWithEmit;
}
/** The node http/https modules to patch — the real ones by default, fakes in tests. */
export interface HttpServerTarget {
  http: { Server: ServerCtor };
  https: { Server: ServerCtor };
}

type IncomingHeaders = Record<string, string | string[] | undefined>;
interface ServerRequestLike {
  method?: string;
  url?: string;
  headers: IncomingHeaders;
}
interface ServerResponseLike {
  statusCode: number;
  /** True once the response has been fully written — distinguishes a normal close from a client abort. */
  writableFinished: boolean;
  once(event: string, listener: () => void): unknown;
}

export interface HttpServerInterceptorOptions {
  /** The http/https modules to patch (their `Server.prototype.emit`). Default the real node modules. */
  target?: HttpServerTarget;
  /** Resolve the active client; forwarded to runServerRequest. Default the process-singleton carrier client. */
  getClient?: () => BugseeClient | undefined;
  /** Mint a context id; forwarded. Default `crypto.randomUUID`. */
  newContextId?: () => string;
  /** Skip instrumenting a request (self-isolation). Default: the inbound `x-bugsee-internal` header. */
  isInternal?: (headers: IncomingHeaders) => boolean;
}

/** An installable server instrumentation — `install()`/`uninstall()` are idempotent and driven by
 * launch/stop. The shared shape for the node:http patch AND the per-runtime native serve wraps
 * (Bun.serve/Deno.serve) that platforms inject via the launch seam. */
export interface ServerInstallable {
  install(): void;
  uninstall(): void;
}

/** The node:http server interceptor — a {@link ServerInstallable} patching http(s).Server.prototype.emit. */
export type HttpServerInterceptor = ServerInstallable;

/** Default self-isolation: skip the SDK's own inbound traffic, tagged X-Bugsee-Internal (node lowercases). */
const defaultIsInternal = (headers: IncomingHeaders): boolean =>
  headers != null && headers['x-bugsee-internal'] !== undefined;

const readTraceparent = (headers: IncomingHeaders): string | undefined => {
  const tp = headers?.traceparent;
  return typeof tp === 'string' ? tp : undefined;
};

interface Patch {
  proto: ProtoWithEmit;
  hadOwn: boolean;
  original: EmitFn;
}

export function createHttpServerInterceptor(
  options: HttpServerInterceptorOptions = {},
): HttpServerInterceptor {
  const target = options.target ?? ({ http, https } as unknown as HttpServerTarget);
  const isInternal = options.isInternal ?? defaultIsInternal;
  const runOptions: ServerInstrumentOptions = {};
  if (options.getClient !== undefined) {
    runOptions.getClient = options.getClient;
  }
  if (options.newContextId !== undefined) {
    runOptions.newContextId = options.newContextId;
  }

  let installed = false;
  let patches: Patch[] = [];

  const makePatched = (original: EmitFn): EmitFn =>
    function patchedEmit(this: unknown, event, ...rest): boolean {
      if (event !== 'request') {
        return original.call(this, event, ...rest);
      }
      const req = rest[0] as ServerRequestLike | undefined;
      const res = rest[1] as ServerResponseLike | undefined;
      if (req === undefined || res === undefined || isInternal(req.headers)) {
        return original.call(this, event, ...rest);
      }

      return runServerRequest(
        {
          method: req.method ?? 'GET',
          url: req.url ?? '',
          traceparent: readTraceparent(req.headers),
        },
        runOptions,
        (span) => {
          // Finish on 'close' — it fires AFTER 'finish' (and after any dedicated adapter's own 'finish'
          // listener), so when this span is the OWNER and an adapter refines it (re-entrancy), the adapter's
          // route lands in the txn name before we finish. writableFinished distinguishes a completed
          // response (finish OK/ERROR by status) from a client abort (cancel → CANCELLED).
          res.once('close', () => {
            if (res.writableFinished) {
              span.finish(res.statusCode);
            } else {
              span.cancel();
            }
          });
          return original.call(this, event, ...rest);
        },
      );
    };

  return {
    install(): void {
      if (installed) {
        return;
      }
      installed = true;
      for (const ctor of [target.http.Server, target.https.Server]) {
        const proto = ctor.prototype;
        const hadOwn = Object.hasOwn(proto, 'emit');
        const original = proto.emit;
        patches.push({ proto, hadOwn, original });
        proto.emit = makePatched(original);
      }
    },
    uninstall(): void {
      if (!installed) {
        return;
      }
      installed = false;
      for (const { proto, hadOwn, original } of patches) {
        if (hadOwn) {
          proto.emit = original;
        } else {
          // The original emit was inherited (EventEmitter.prototype.emit) — remove our own-property
          // override so the prototype returns to its pristine, inheriting shape.
          delete (proto as { emit?: EmitFn }).emit;
        }
      }
      patches = [];
    },
  };
}
