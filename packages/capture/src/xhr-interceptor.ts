import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import {
  boundedText,
  hasContentType,
  readSyncRequestBody,
  type SyncBodyRead,
} from './network-body';

// XMLHttpRequest capture SOURCE (design §16.2). XHR is browser/electron-renderer only, so the wrap is
// installed only when XMLHttpRequest exists (availability-detected) — on other runtimes onActivate is
// a no-op. Wrapping is done by patching the PROTOTYPE methods (open/setRequestHeader/send) rather than
// replacing the constructor, so existing XHR instances are unaffected; per-instance state lives in a
// WeakMap (no instance pollution). Emits before → complete | error | abort with url/method/headers/
// status/timing, sharing one id+sequence. Metadata-first: bodies deferred. Raw events (the consumer
// sanitizes). Installed only while ACTIVE (subscriber-presence / start, via InterceptorBase).

// XHR lib types aren't available here; reach the relevant surface via minimal structural casts.
type XhrInstance = {
  addEventListener(type: string, listener: () => void): void;
  status: number;
  statusText: string;
  getAllResponseHeaders(): string;
  /** '' | 'text' → responseText is valid; 'json' → response is the parsed value; others → binary/doc. */
  responseType: string;
  /** The response body as text (valid only when responseType is '' or 'text'). */
  responseText: string;
  /** The typed response (used for responseType 'json'). */
  response: unknown;
};
type XhrMethods = {
  open(method: string, url: string, ...rest: unknown[]): unknown;
  send(body?: unknown): unknown;
  setRequestHeader(name: string, value: string): unknown;
};
type XhrConstructor = { prototype: XhrMethods };

/** A read handle for the XMLHttpRequest constructor to wrap — the global by default, or a custom impl. */
export interface XhrTarget {
  get(): XhrConstructor | undefined;
}

const globalXhrTarget: XhrTarget = {
  get: () => (globalThis as unknown as { XMLHttpRequest?: XhrConstructor }).XMLHttpRequest,
};

// Parse getAllResponseHeaders()'s "name: value\r\n…" blob into a record.
const parseResponseHeaders = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of raw.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return out;
};

const hasInternalHeader = (headers: Record<string, string>): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === 'x-bugsee-internal');

interface XhrState {
  method: string;
  url: string;
  headers: Record<string, string>;
  id: string;
  startedAt: number;
}

export interface XhrInterceptorOptions {
  now?: () => number;
  newId?: () => string;
  isInternal?: (url: string, requestHeaders: Record<string, string>) => boolean;
  /** Where to read the wrapped XMLHttpRequest constructor — the global by default, or a custom impl. */
  target?: XhrTarget;
  /** Capture request/response bodies. Default true; off skips reading the response body entirely. */
  captureBodies?: boolean;
  /** Max captured body size in bytes (response over-cap → size_too_large). Default 20480. */
  maxBodyBytes?: number;
}

class XhrInterceptor extends InterceptorBase<Record<NetworkStage, NetworkEvent>> {
  readonly name = 'xhr';
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #isInternal: (url: string, headers: Record<string, string>) => boolean;
  readonly #target: XhrTarget;
  readonly #captureBodies: boolean;
  readonly #maxBodyBytes: number;
  readonly #state = new WeakMap<object, XhrState>();
  #originals: XhrMethods | null = null;
  #counter = 0;

  constructor(options: XhrInterceptorOptions = {}) {
    super();
    this.#now = options.now ?? (() => Date.now());
    this.#newId =
      options.newId ??
      (() => {
        this.#counter += 1;
        return `x${this.#counter}`;
      });
    this.#isInternal = options.isInternal ?? ((_url, headers) => hasInternalHeader(headers));
    this.#target = options.target ?? globalXhrTarget;
    this.#captureBodies = options.captureBodies ?? true;
    this.#maxBodyBytes = options.maxBodyBytes ?? 20480;
  }

  protected onActivate(): void {
    const ctor = this.#target.get();
    if (ctor === undefined) {
      return; // no XMLHttpRequest in this runtime / target
    }
    const proto = ctor.prototype;
    this.#originals = {
      open: proto.open,
      send: proto.send,
      setRequestHeader: proto.setRequestHeader,
    };
    proto.open = this.#wrapOpen(this.#originals.open);
    proto.setRequestHeader = this.#wrapSetHeader(this.#originals.setRequestHeader);
    proto.send = this.#wrapSend(this.#originals.send);
  }

  protected override onDeactivate(): void {
    const ctor = this.#target.get();
    if (ctor !== undefined && this.#originals !== null) {
      ctor.prototype.open = this.#originals.open;
      ctor.prototype.send = this.#originals.send;
      ctor.prototype.setRequestHeader = this.#originals.setRequestHeader;
    }
    this.#originals = null;
  }

  #wrapOpen(original: XhrMethods['open']): XhrMethods['open'] {
    const self = this;
    return function (this: XhrInstance, method: string, url: string, ...rest: unknown[]): unknown {
      self.#state.set(this, {
        method: String(method).toUpperCase(),
        url: String(url),
        headers: {},
        id: '',
        startedAt: 0,
      });
      return original.apply(this, [method, url, ...rest]);
    };
  }

  #wrapSetHeader(original: XhrMethods['setRequestHeader']): XhrMethods['setRequestHeader'] {
    const self = this;
    return function (this: XhrInstance, name: string, value: string): unknown {
      const state = self.#state.get(this);
      if (state !== undefined) {
        state.headers[name] = value;
      }
      return original.apply(this, [name, value]);
    };
  }

  #wrapSend(original: XhrMethods['send']): XhrMethods['send'] {
    const self = this;
    return function (this: XhrInstance, body?: unknown): unknown {
      const state = self.#state.get(this);
      if (state !== undefined && !self.#isInternal(state.url, state.headers)) {
        const id = self.#newId();
        state.id = id;
        state.startedAt = self.#now();
        // Capture the request body (string / URLSearchParams). Reflect the runtime-implied Content-Type
        // only when the caller set none (so the captured headers match the wire and the gate keeps it).
        const reqBody = readSyncRequestBody(body);
        if (reqBody.contentType !== undefined && !hasContentType(state.headers)) {
          state.headers['content-type'] = reqBody.contentType;
        }
        self.emit('before', {
          timestamp: state.startedAt,
          id,
          sequence: id,
          mechanism: 'xhr',
          url: state.url,
          method: state.method,
          type: 'before',
          custom: {
            headers: state.headers,
            ...(reqBody.body !== undefined ? { body: reqBody.body } : {}),
            ...(reqBody.reason !== undefined ? { no_body_reason: reqBody.reason } : {}),
          },
        });
        this.addEventListener('load', () => self.#complete(this, state));
        this.addEventListener('error', () => self.#fail(state, 'error', 'network error'));
        this.addEventListener('timeout', () => self.#fail(state, 'error', 'timeout'));
        this.addEventListener('abort', () => self.#fail(state, 'abort', 'aborted'));
      }
      return original.apply(this, [body]);
    };
  }

  // Read the RESPONSE body at `load` — already buffered, so reading is synchronous and side-effect-free
  // (no stream to disturb). Valid only for text-ish responseTypes: '' / 'text' → responseText; 'json' →
  // the parsed `response` re-serialized. Binary / document responseTypes can't be read as text →
  // cant_read_data. Bounded by maxBodyBytes (over-cap → size_too_large, body not included).
  #readResponseBody(xhr: XhrInstance): SyncBodyRead {
    const type = xhr.responseType;
    if (type === '' || type === 'text') {
      return boundedText(xhr.responseText, this.#maxBodyBytes);
    }
    if (type === 'json') {
      let json: string | undefined;
      try {
        json = JSON.stringify(xhr.response);
      } catch {
        return { reason: 'cant_read_data' }; // circular / non-serializable
      }
      return json === undefined
        ? { reason: 'cant_read_data' }
        : boundedText(json, this.#maxBodyBytes);
    }
    return { reason: 'cant_read_data' }; // arraybuffer / blob / document — not text
  }

  #complete(xhr: XhrInstance, state: XhrState): void {
    const resBody = this.#captureBodies ? this.#readResponseBody(xhr) : {};
    this.emit('complete', {
      timestamp: this.#now(),
      id: state.id,
      sequence: state.id,
      mechanism: 'xhr',
      url: state.url,
      method: state.method,
      type: 'complete',
      status: xhr.status,
      statusText: xhr.statusText,
      custom: {
        headers: parseResponseHeaders(xhr.getAllResponseHeaders()),
        timings: { duration: this.#now() - state.startedAt },
        ...(resBody.body !== undefined ? { body: resBody.body } : {}),
        ...(resBody.reason !== undefined ? { no_body_reason: resBody.reason } : {}),
      },
    });
  }

  #fail(state: XhrState, stage: 'error' | 'abort', message: string): void {
    this.emit(stage, {
      timestamp: this.#now(),
      id: state.id,
      sequence: state.id,
      mechanism: 'xhr',
      url: state.url,
      method: state.method,
      type: stage,
      customError: message,
      custom: { error: message },
    });
  }
}

export function createXhrInterceptor(
  options?: XhrInterceptorOptions,
): Interceptor<Record<NetworkStage, NetworkEvent>> {
  return new XhrInterceptor(options);
}
