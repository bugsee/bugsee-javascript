// Async origin capture (docs/design/async-origin-capture.md §4). A platform API that fails ASYNCHRONOUSLY rejects with a
// value that has no stack (`video.play()` → a `NotSupportedError` DOMException), so the report says what failed and not where.
// This wraps the promise-returning methods listed in `async-origin-table.ts` and records the CALL SITE, keyed by the REASON
// object so it can be found again wherever the rejection surfaces (`unhandledrejection`, a framework's error handler, a boundary).
//
// The trap that shapes the code: attaching ANY reaction to a promise marks it handled and silences `unhandledrejection`. So the
// wrapper returns a DERIVED promise, built with a PRISTINE `then` (never the global one, which zone.js / core-js / Bluebird
// replace), and when no pristine `then` exists it attaches nothing and keys the origin by the returned promise instead.
// A wrapper must never break the app's call: every failure of our own degrades to "return the platform's promise untouched".
//
// Runtime-portable: it reaches runtime globals only through the injected `global`; no DOM or `node:*` types.
import {
  ASYNC_ORIGIN_EXTRAS,
  ASYNC_ORIGIN_TABLE,
  type AsyncOriginMode,
  type AsyncOriginRow,
  rowTargets,
} from './async-origin-table';

/** Where a platform API was called. */
export interface AsyncOrigin {
  /** `Interface.method` of the target the method was found on, e.g. `HTMLMediaElement.play`. */
  api: string;
  /** The receiver (`this`) of the call: the element / registry / context. Describe it at REPORT time, not here. */
  target: unknown;
  /** Holds the call-site stack. `.stack` is formatted lazily by the engine, so reading it is paid only when a report needs it. */
  holder: { stack?: string };
  /** Leading stack frames that are the wrapper's own (1 when the engine could not omit it, else 0). */
  skip: number;
}

export interface AsyncOriginRecorder {
  /** The origin for a rejection reason: its own, else one found through `reason.cause` (a few levels). */
  originOf(reason: unknown): AsyncOrigin | undefined;
  /** The origin recorded against a promise, for the fallback mode that attaches no reaction (a bare call only). */
  originOfPromise(promise: unknown): AsyncOrigin | undefined;
  /** Install the `armed` rows. Called on the first stackless rejection nobody could locate; idempotent. */
  arm(): void;
  /** `Interface.method` of every wrapper currently installed (targets named for mixins). */
  readonly installed: readonly string[];
  /** Restore every method this recorder wrapped (leaving one that another patcher has since wrapped on top). */
  stop(): void;
}

type ThenFn = (this: unknown, ...args: unknown[]) => unknown;
type CaptureStackTrace = (target: object, constructorOpt: (...args: never[]) => unknown) => void;

export interface InstallAsyncOriginsOptions {
  /** The realm to patch. Default `globalThis`. */
  global?: object;
  /** Default: the generated table plus the hand-added extras. */
  rows?: readonly AsyncOriginRow[];
  /** Which modes to install. Default `['always', 'armed']`; `armed` rows install on `arm()`, `off` rows only when asked for. */
  modes?: readonly AsyncOriginMode[];
  /** Per-method cap on captured call sites per minute; the call passes through untouched beyond it. Default 200. */
  maxCapturesPerMinute?: number;
  /** A `then` known to be the engine's own. Default: the global one if still native, else a hidden iframe's. `null`: none. */
  cleanThen?: ThenFn | null;
  /** `Error.captureStackTrace` where the engine has it (omits the wrapper frame, one capture). `null`: not available. */
  captureStackTrace?: CaptureStackTrace | null;
  setInterval?: ((fn: () => void, ms: number) => unknown) | undefined;
  clearInterval?: ((handle: unknown) => void) | undefined;
  onError?: (error: unknown) => void;
}

const MARK = Symbol.for('bugsee.asyncOrigin');
const CAUSE_DEPTH = 3;
const BUDGET_WINDOW_MS = 60_000;
const DEFAULT_BUDGET = 200;
const ZONE_THEN = '__zone_symbol__then';

const isObjectLike = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

const isThenable = (value: unknown): value is { then: unknown } =>
  isObjectLike(value) && typeof (value as { then?: unknown }).then === 'function';

const isNative = (fn: unknown): boolean =>
  typeof fn === 'function' &&
  /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn));

/** A `then` that is the engine's own, read once at install. See design §4.1a. Never throws: a hostile realm just has none. */
function cleanThenOf(global: Record<string, unknown>): ThenFn | undefined {
  try {
    const own = (global.Promise as { prototype?: { then?: unknown } } | undefined)?.prototype?.then;
    if (isNative(global.Promise) && isNative(own)) {
      return own as ThenFn;
    }
    // The global Promise was replaced (zone.js, core-js, Bluebird): a fresh same-origin iframe still has the native one. A promise
    // from another realm is fine: the brand check is on the promise, not the realm.
    const doc = global.document as
      | {
          createElement?: (tag: string) => {
            style?: Record<string, string>;
            setAttribute?: (name: string, value: string) => void;
            remove?: () => void;
            contentWindow?: { Promise?: { prototype?: { then?: unknown } } };
          };
          documentElement?: { appendChild?: (node: unknown) => unknown };
        }
      | undefined;
    const frame = doc?.createElement?.('iframe');
    if (frame === undefined || doc?.documentElement?.appendChild === undefined) {
      return undefined;
    }
    if (frame.style !== undefined) {
      frame.style.display = 'none';
    }
    frame.setAttribute?.('aria-hidden', 'true');
    doc.documentElement.appendChild(frame);
    const then = frame.contentWindow?.Promise?.prototype?.then;
    frame.remove?.();
    return isNative(then) ? (then as ThenFn) : undefined;
  } catch {
    return undefined;
  }
}

interface Installed {
  key: string;
  owner: Record<string, unknown>;
  name: string;
  original: unknown;
  wrapper: unknown;
  state: { active: boolean };
}

export function installAsyncOrigins(options: InstallAsyncOriginsOptions = {}): AsyncOriginRecorder {
  const global = (options.global ?? globalThis) as Record<string, unknown>;
  const rows = options.rows ?? [...ASYNC_ORIGIN_TABLE, ...ASYNC_ORIGIN_EXTRAS];
  const modes = new Set<AsyncOriginMode>(options.modes ?? ['always', 'armed']);
  const budget = options.maxCapturesPerMinute ?? DEFAULT_BUDGET;
  const onError = options.onError ?? (() => undefined);
  const cleanThen =
    options.cleanThen === undefined ? cleanThenOf(global) : (options.cleanThen ?? undefined);
  const captureStackTrace: CaptureStackTrace | undefined =
    options.captureStackTrace === undefined
      ? (
          global.Error as { captureStackTrace?: CaptureStackTrace } | undefined
        )?.captureStackTrace?.bind(global.Error)
      : (options.captureStackTrace ?? undefined);
  const setTimer =
    'setInterval' in options
      ? options.setInterval
      : (global.setInterval as typeof options.setInterval);
  const clearTimer =
    'clearInterval' in options
      ? options.clearInterval
      : (global.clearInterval as typeof options.clearInterval);

  const byReason = new WeakMap<object, AsyncOrigin>();
  const byPromise = new WeakMap<object, AsyncOrigin>();
  const counters: { used: number }[] = [];
  const installed: Installed[] = [];
  let timer: unknown;
  let timerStarted = false;
  let stopped = false;

  const startTimer = (): void => {
    if (timerStarted || setTimer === undefined) {
      return;
    }
    timerStarted = true;
    timer = setTimer(() => {
      for (const counter of counters) {
        counter.used = 0;
      }
    }, BUDGET_WINDOW_MS);
    (timer as { unref?: () => void } | undefined)?.unref?.();
  };

  const thenOf = (promise: object): ThenFn | undefined => {
    const stored = (promise as Record<string, unknown>)[ZONE_THEN];
    return typeof stored === 'function' ? (stored as ThenFn) : cleanThen;
  };

  function wrap(owner: Record<string, unknown>, name: string, api: string): Installed | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    const original = descriptor?.value;
    if (
      descriptor === undefined ||
      typeof original !== 'function' ||
      (original as { [MARK]?: boolean })[MARK] === true
    ) {
      return undefined;
    }
    const state = { active: true };
    const counter = { used: 0 };

    const observe = (
      promise: object,
      target: unknown,
      self: (...args: never[]) => unknown,
    ): unknown => {
      if (counter.used >= budget) {
        return promise;
      }
      counter.used++;
      const holder: { stack?: string } = {};
      let skip = 0;
      if (captureStackTrace !== undefined) {
        captureStackTrace(holder, self);
      } else {
        holder.stack = new Error().stack;
        skip = 2; // `observe` and `wrapped` sit above the caller; captureStackTrace(…, self) omits both
      }
      const origin: AsyncOrigin = { api, target, holder, skip };
      const then = thenOf(promise);
      if (then !== undefined) {
        try {
          const derived = then.call(promise, undefined, (reason: unknown) => {
            // Only a reason with no stack of its own is worth remembering, and the FIRST origin wins.
            if (isObjectLike(reason) && !byReason.has(reason)) {
              const stack = (reason as { stack?: unknown }).stack;
              if (typeof stack !== 'string' || stack === '') {
                byReason.set(reason, origin);
              }
            }
            throw reason;
          });
          if (isThenable(derived)) {
            return derived;
          }
        } catch {
          // fall through: no usable then on this promise
        }
      }
      byPromise.set(promise, origin);
      return promise;
    };

    const wrapper = function wrapped(this: unknown, ...args: unknown[]): unknown {
      const result = (original as (...a: unknown[]) => unknown).apply(this, args);
      if (!state.active || !isThenable(result)) {
        return result;
      }
      try {
        return observe(result as object, this, wrapped as never);
      } catch {
        return result;
      }
    };
    Object.defineProperty(wrapper, 'name', {
      value: (original as { name: string }).name,
      configurable: true,
    });
    Object.defineProperty(wrapper, 'length', {
      value: (original as { length: number }).length,
      configurable: true,
    });
    Object.defineProperty(wrapper, 'toString', {
      value: () => Function.prototype.toString.call(original),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(wrapper, MARK, { value: true });
    try {
      Object.defineProperty(owner, name, { ...descriptor, value: wrapper });
    } catch {
      return undefined; // frozen or sealed prototype
    }
    if (owner[name] !== wrapper) {
      return undefined; // a setter-less or otherwise ignored define
    }
    counters.push(counter);
    return { key: api, owner, name, original, wrapper, state };
  }

  const installRows = (wanted: (mode: AsyncOriginMode) => boolean): void => {
    for (const row of rows) {
      if (!wanted(row.mode)) {
        continue;
      }
      for (const target of rowTargets(row)) {
        try {
          const owner =
            target === 'globalThis'
              ? global
              : (global[target] as { prototype?: unknown } | undefined)?.prototype;
          if (!isObjectLike(owner)) {
            continue;
          }
          for (const method of row.methods) {
            const entry = wrap(owner as Record<string, unknown>, method, `${target}.${method}`);
            if (entry !== undefined) {
              installed.push(entry);
            }
          }
        } catch (error) {
          onError(error);
        }
      }
    }
    if (installed.length > 0) {
      startTimer();
    }
  };

  installRows((mode) => mode === 'always' && modes.has('always'));
  if (modes.has('off')) {
    installRows((mode) => mode === 'off');
  }

  return {
    originOf(reason: unknown): AsyncOrigin | undefined {
      let current: unknown = reason;
      // Bounded, so a cyclic `cause` costs a few steps rather than a loop.
      for (let depth = 0; depth <= CAUSE_DEPTH && isObjectLike(current); depth++) {
        const found = byReason.get(current);
        if (found !== undefined) {
          return found;
        }
        current = (current as { cause?: unknown }).cause;
      }
      return undefined;
    },
    originOfPromise(promise: unknown): AsyncOrigin | undefined {
      return isObjectLike(promise) ? byPromise.get(promise) : undefined;
    },
    arm(): void {
      if (stopped || !modes.has('armed')) {
        return; // already-wrapped methods are skipped by their mark, so a second call is a no-op
      }
      installRows((mode) => mode === 'armed');
    },
    get installed(): readonly string[] {
      return installed.filter((entry) => entry.state.active).map((entry) => entry.key);
    },
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const entry of installed) {
        entry.state.active = false;
        // Leave it alone when another patcher wrapped on top of ours: restoring would drop THEIR patch.
        if (entry.owner[entry.name] === entry.wrapper) {
          try {
            Object.defineProperty(entry.owner, entry.name, {
              ...Object.getOwnPropertyDescriptor(entry.owner, entry.name),
              value: entry.original,
            });
          } catch (error) {
            onError(error);
          }
        }
      }
      if (timerStarted && clearTimer !== undefined) {
        clearTimer(timer);
      }
    },
  };
}
