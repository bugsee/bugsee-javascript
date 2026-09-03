import { createRequire } from 'node:module';
import {
  type Clock,
  createRateLimiter,
  createSystemClock,
  isUserFrame,
  parseLocation,
  type Scheduler,
  type StackFrame,
} from '@bugsee/core';
import { isSensitiveKey, REDACTED } from '@bugsee/protocol';

// Local variables at the moment of the throw (design reference: Sentry's LocalVariables integration;
// Android has no analogue because a Java stack frame carries no locals). "It threw" becomes "it threw
// with orderId=null", which is the single biggest step-change a crash report can carry.
//
// OFF BY DEFAULT, and pause-on-UNCAUGHT only. Re-measured on Node 24 (2026-09-03), same process,
// same 20k-iteration workload, so every row is comparable:
//   no debugger at all                        1.8 µs per throw
//   Debugger.enable                           2.2 µs
//   + pauseOnExceptions 'uncaught'            2.7 µs
//   + pauseOnExceptions 'all', resume only  256.3 µs
//   + pauseOnExceptions 'all', 5 frames     409.6 µs   ← what `includeCaught: true` actually costs
//
// That last figure CORRECTS the "~36µs per caught throw" this comment used to carry: the old number
// was measured without a `Debugger.paused` listener doing the round-trip the real capture does, and it
// understated the cost by an order of magnitude. A caught throw with `includeCaught` on costs ~230×
// what the same throw costs with no debugger — so an application that uses exceptions for control flow
// does not merely pay "a bit more", it stops being the same application.
//
// Which is why `includeCaught` is opt-in on top of an opt-in AND rate-limited (see
// {@link LocalVariablesOptions.maxCaughtPerSecond}). Note where the cost sits: 254 of those 410 µs are
// the PAUSE itself, before the capture does anything. Declining to capture inside the handler would
// therefore save only a third of it — the only effective throttle is to stop pausing, which is what
// the limiter does.

/** The slice of a `node:inspector` Session this needs — injected, so the whole flow is testable. */
export interface InspectorSessionLike {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    params?: unknown,
    callback?: (err: Error | null, result?: unknown) => void,
  ): void;
  on(event: string, handler: (message: { params: unknown }) => void): void;
}

export interface LocalVariablesOptions {
  /**
   * Also pause on CAUGHT exceptions. Default false. Costs ~36µs per caught throw, so an application
   * that throws in a hot path pays it continuously — measure before enabling.
   */
  includeCaught?: boolean;
  /** How many frames from the top to capture locals for. Default 5. */
  maxFrames?: number;
  /** Max variables per frame, in the order the runtime reports them. Default 20. */
  maxVariables?: number;
  /** Max characters of any one stringified value. Default 120. */
  maxValueLength?: number;
  /** How many exceptions' locals to hold before the oldest is evicted. Default 20. */
  maxCached?: number;
  /**
   * How many caught exceptions per second may be paused on before capture drops back to
   * uncaught-only for a while. Default 50 — Sentry's figure, and at the measured 410 µs per capture it
   * caps the feature's cost at roughly 2% of one core.
   *
   * Only consulted when {@link includeCaught} is set. An UNCAUGHT exception is never rate-limited:
   * there is one per process, at the end of it, and it is the crash the feature exists to explain.
   */
  maxCaughtPerSecond?: number;
  /** Clock seam (monotonic, so a wall-clock jump cannot widen or collapse the window). */
  clock?: Clock;
  /** Scheduler seam for the recovery tick. Its timers MUST be `unref`'d. */
  scheduler?: Scheduler;
  /**
   * Also read the scope `logException` was CALLED from, by pausing the process for the duration of that
   * call. Default true (the feature is already opt-in as a whole).
   *
   * This is the half that does not need {@link includeCaught}. A caught exception's throw site is only
   * visible if the debugger stopped on the throw, which costs ~410 µs on EVERY throw the application
   * makes; the report site costs ~410 µs on every `logException` CALL, which for most applications is
   * several orders of magnitude rarer. What it gives up is the frames between the try and the throw —
   * it sees the catch block and everything below it, not the function that failed.
   */
  reportSite?: boolean;
  /** Test seam: the inspector session. Default a real `node:inspector` Session. */
  session?: InspectorSessionLike;
  onError?: (error: unknown) => void;
}

/** Frame-indexed locals, top frame first. */
export type FrameLocals = Array<Record<string, string>>;

/** One live frame at the report site: where it is, and what was in scope there. */
export interface ReportSiteFrame extends StackFrame {
  locals: Record<string, string>;
}

export interface LocalVariablesCapture {
  /** The locals captured for `error`, or undefined if none were. */
  lookup(error: unknown): FrameLocals | undefined;
  /**
   * Read the live scope for `error` NOW — core's `onReportSite`, called while the caller's catch block
   * is still on the stack. Pauses the process for the duration.
   */
  captureReportSite(error: unknown): void;
  /** The report-site frames captured for `error`, consumed: a second read gets nothing. */
  takeReportSite(error: unknown): ReportSiteFrame[] | undefined;
  stop(): void;
}

/**
 * The key the thrown object is stamped with so the pause can be matched to the Error later.
 *
 * Non-enumerable, so it never shows up in a `JSON.stringify` of the user's error, in a `for...in`, or
 * in an object dump the app itself makes — the SDK must not alter application behaviour, and an
 * enumerable marker on someone's error object is exactly that.
 */
const MARKER = '__bugsee_locals_id__';

/** One entry of V8's `ObjectPreview` — a property it rendered for us, without running any user code. */
interface PropertyPreview {
  name?: unknown;
  type?: unknown;
  value?: unknown;
}

/**
 * V8's own one-level rendering of an object or array, returned in the SAME `Runtime.getProperties`
 * response when `generatePreview` is set. `overflow` says V8 stopped early (it previews five).
 */
interface ObjectPreview {
  overflow?: unknown;
  properties?: readonly PropertyPreview[];
}

/**
 * Render one previewed property. A sensitive NAME is redacted here exactly as it is at the top level —
 * `isSensitiveKey` is the SDK's single definition of sensitive and a secret does not stop being one a
 * level down. Strings are quoted so `{seats: 7}` and `{seats: '7'}` stay distinguishable.
 */
function renderPreviewEntry(entry: PropertyPreview): string {
  const name = typeof entry.name === 'string' ? entry.name : '?';
  if (isSensitiveKey(name)) {
    return `${name}: ${REDACTED}`;
  }
  const raw = typeof entry.value === 'string' ? entry.value : String(entry.value ?? 'undefined');
  return `${name}: ${entry.type === 'string' ? `'${raw}'` : raw}`;
}

/**
 * `Runtime.getProperties` describes a value; render it short, one level deep, and NEVER by calling
 * user code.
 *
 * Objects and arrays used to render as V8's bare `description` — the literal word `Object` — which told
 * a reader nothing. They are now unrolled ONE level from the `preview` V8 already put in the same
 * response, so `customer` reads `{tier: 'gold', seats: 7}`.
 *
 * The preview is the whole reason this stays cheap and safe. Sentry's integration issues a SECOND
 * `Runtime.getProperties` per object-valued local, which is another round-trip inside a paused process
 * for every one of them; asking for `generatePreview` costs none, because V8 renders it while it is
 * already building the response. It is also GETTER-SAFE — verified against a real `node:inspector`
 * session: a local holding `{ get danger() { throw } }` previews as `danger=undefined` and the getter
 * does not run. Invoking an accessor from here would be the SDK changing what the application does.
 *
 * Depth stops at one. A nested object stays the word `Object`: deeper walks cost pause time on a
 * stopped process and are a good way to serialise something enormous by accident.
 */
export function renderValue(description: unknown, maxLength: number): string {
  const value = description as
    | {
        type?: string;
        value?: unknown;
        description?: string;
        subtype?: string;
        preview?: ObjectPreview;
      }
    | undefined;
  if (value === undefined) {
    return 'undefined';
  }
  if (value.type === 'undefined') {
    return 'undefined';
  }
  if (value.subtype === 'null') {
    return 'null';
  }
  const clip = (text: string): string =>
    text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;

  const entries = value.preview?.properties;
  if (entries !== undefined) {
    const isArray = value.subtype === 'array';
    const parts = entries.map(renderPreviewEntry);
    if (value.preview?.overflow === true) {
      parts.push('…');
    }
    const body = isArray
      ? // An array's preview names are its indices; they carry nothing a reader wants to see.
        parts.map((part) => part.replace(/^\d+: /, '')).join(', ')
      : parts.join(', ');
    return clip(isArray ? `[${body}]` : `{${body}}`);
  }

  // `description` is V8's own rendering (e.g. "Array(3)", "function foo"). Preferring the primitive
  // `value` when present keeps numbers and booleans readable; falling back to `description` avoids
  // ever invoking a user `toString`, which could throw or have side effects.
  const rendered =
    value.value !== undefined && value.type !== 'object'
      ? String(value.value)
      : (value.description ?? String(value.type ?? 'unknown'));
  return clip(rendered);
}

/**
 * Build the `{name: value}` map for one scope, scrubbing by NAME through the SDK's single definition of
 * a sensitive key (`@bugsee/protocol`'s `isSensitiveKey`) rather than restating one here — the same
 * predicate that redacts headers and query params. A local called `password` is a password.
 */
export function collectScope(
  properties: readonly unknown[],
  maxVariables: number,
  maxValueLength: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  let taken = 0;
  for (const raw of properties) {
    if (taken >= maxVariables) {
      break;
    }
    const property = raw as { name?: unknown; value?: unknown };
    const name = typeof property.name === 'string' ? property.name : undefined;
    if (name === undefined) {
      continue;
    }
    out[name] = isSensitiveKey(name) ? REDACTED : renderValue(property.value, maxValueLength);
    taken += 1;
  }
  return out;
}

/** A capture that does nothing — returned when the inspector is unavailable or refused to start. */
const inert: LocalVariablesCapture = {
  lookup: () => undefined,
  captureReportSite: () => {},
  takeReportSite: () => undefined,
  stop: () => {},
};

// The caught-exception throttle (design reference: Sentry's `createRateLimiter`). Their SHAPE is right
// and adopted: when the app throws faster than the limit, do not merely skip the capture — stop pausing
// at all, by dropping `setPauseOnExceptions` back to `uncaught`, then restore it after a backoff that
// doubles each time the storm comes straight back.
//
// Their RATCHET is not adopted. Sentry's backoff only ever grows (5s doubling to a 24h ceiling, reset
// never), so an application with one short burst every few minutes climbs to the ceiling and then goes
// the rest of the process without capturing a single caught exception — indistinguishable, to its
// owner, from the feature being broken. Here a storm that arrives a quiet {@link BACKOFF_RESET_MS}
// after the last recovery is treated as a NEW storm and starts again from the base delay.
const RATE_WINDOW_MS = 1_000;
/** First backoff. Sentry doubles before its first disable and so starts at 10s; the first trip is the
 *  cheapest one to recover from, so it starts at the base here. */
const BASE_BACKOFF_MS = 5_000;
/** Ceiling, as Sentry's: past a day the distinction stops meaning anything. */
const MAX_BACKOFF_MS = 86_400_000;
/** Quiet time after a recovery that makes the next storm a new one rather than the same one escalating. */
const BACKOFF_RESET_MS = 60_000;
/** How often the recovery timer looks at the clock. Only runs while capture is actually held back. */
const BACKOFF_TICK_MS = 1_000;

/** Default scheduler: global timers, `unref`'d so the recovery tick cannot hold a process open. */
const globalTimers = globalThis as unknown as {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};
const defaultScheduler: Scheduler = {
  setInterval: (callback, ms) => {
    const handle = globalTimers.setInterval(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => globalTimers.clearInterval(handle),
};

export function createLocalVariablesCapture(
  options: LocalVariablesOptions = {},
): LocalVariablesCapture {
  const {
    includeCaught = false,
    maxFrames = 5,
    maxVariables = 20,
    maxValueLength = 120,
    maxCached = 20,
    maxCaughtPerSecond = 50,
    reportSite: reportSite_enabled = true,
  } = options;
  const onError = options.onError ?? ((): void => {});
  const clock = options.clock ?? createSystemClock();
  const scheduler = options.scheduler ?? defaultScheduler;
  const session = options.session;
  if (session === undefined) {
    return inert; // no session injected and no runtime probe wired yet — see `launch.ts`
  }

  const cache = new Map<string, FrameLocals>();
  let nextId = 0;
  let stopped = false;

  // scriptId → url. MEASURED on Node 24: an in-process session's `Debugger.CallFrame.url` is ALWAYS the
  // empty string, however the script was loaded — the field exists and is never filled in. The only way
  // to learn where a live frame is, is to keep the `Debugger.scriptParsed` announcements, which
  // `Debugger.enable` replays for every script already parsed.
  const scriptUrls = new Map<string, string>();
  let reportSite: { error: unknown; frames: ReportSiteFrame[] } | undefined;
  let reportSiteError: unknown;
  let awaitingReportSite = false;

  /**
   * Post a `setPauseOnExceptions` state, reporting rather than throwing.
   *
   * Every caller is either arming the capture or recovering it, and neither is worth failing a launch
   * or a pause handler for.
   */
  const setPauseState = (state: 'all' | 'uncaught'): void => {
    try {
      session.post('Debugger.setPauseOnExceptions', { state });
    } catch (error) {
      onError(error);
    }
  };

  // Armed only for caught exceptions. `createRateLimiter` is core's — the SDK has one definition of a
  // rolling rate window, and it already reads the monotonic clock, which is what stops a wall-clock
  // adjustment from collapsing or widening the window mid-storm.
  let limiter: { tryAcquire(): boolean } | undefined;
  try {
    session.connect();
    // BEFORE `Debugger.enable`, and that order is load-bearing: enable REPLAYS a scriptParsed for every
    // script already parsed, synchronously, inside that very post. The application was loaded before the
    // SDK launched, so listening afterwards misses every script that matters — and misses them silently,
    // leaving report-site capture returning nothing for ever rather than reporting a failure.
    session.on('Debugger.scriptParsed', (message) => {
      const script = message.params as { scriptId?: unknown; url?: unknown };
      if (typeof script.scriptId === 'string' && typeof script.url === 'string') {
        scriptUrls.set(script.scriptId, script.url);
      }
    });
    session.post('Debugger.enable');
    if (includeCaught) {
      limiter = createRateLimiter(clock, {
        limit: maxCaughtPerSecond,
        windowMs: RATE_WINDOW_MS,
      });
    }
    session.post('Debugger.setPauseOnExceptions', {
      state: includeCaught ? 'all' : 'uncaught',
    });
  } catch (error) {
    onError(error);
    return inert;
  }

  let backoffMs = BASE_BACKOFF_MS;
  let restoreAt: number | undefined;
  let recoveryTimer: unknown;
  let restoredAt: number | undefined;

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer !== undefined) {
      scheduler.clearInterval(recoveryTimer);
      recoveryTimer = undefined;
    }
  };

  const restore = (): void => {
    restoreAt = undefined;
    clearRecoveryTimer();
    restoredAt = clock.monotonicNow();
    setPauseState('all');
  };

  /**
   * Account for one pause, and hold caught-exception capture back if the app is throwing too fast.
   *
   * A no-op unless {@link LocalVariablesOptions.includeCaught} is on, and a no-op again while capture is
   * already held back — the only pauses arriving then are uncaught ones, which are never throttled.
   */
  const notePause = (): void => {
    if (limiter === undefined || restoreAt !== undefined || limiter.tryAcquire()) {
      return;
    }
    const now = clock.monotonicNow();
    if (restoredAt !== undefined && now - restoredAt >= BACKOFF_RESET_MS) {
      backoffMs = BASE_BACKOFF_MS;
    }
    restoreAt = now + backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    setPauseState('uncaught');
    recoveryTimer = scheduler.setInterval(() => {
      if (restoreAt !== undefined && clock.monotonicNow() >= restoreAt) {
        restore();
      }
    }, BACKOFF_TICK_MS);
  };

  // ALWAYS reached, on every path out of a pause. A debugger that pauses and never resumes freezes the
  // application — which is the one outcome strictly worse than having no local variables at all.
  const resume = (): void => {
    try {
      session.post('Debugger.resume');
    } catch (error) {
      onError(error);
    }
  };

  /**
   * Turn a paused call frame into a located one, through core's own location parser.
   *
   * `parseLocation` is what produced the `file` on the frames this will be matched against, so the two
   * sides are scrubbed by one definition — `file://` stripped, `node_modules` truncated, the app root
   * relativised — and can be compared at all. Undefined when the script was never announced: a frame
   * with no url cannot be lined up with anything, and an unalignable frame can only be attached in the
   * wrong place.
   */
  /**
   * Turn a paused call frame into a located one.
   *
   * ALWAYS returns a frame, even when the script was never announced — the returned array is matched
   * POSITIONALLY against the error's stack, so dropping an entry would shift every frame below it onto
   * the wrong scope. An unlocatable frame simply carries no name and matches nothing.
   *
   * `parseLocation` is core's own, so `file` is scrubbed by the same rules as every wire frame. It is
   * used only to tell the SDK's and the runtime's frames from the application's; alignment never reads
   * it, because it cannot (see {@link alignReportSite}).
   */
  const locate = (rawFrame: unknown): StackFrame => {
    const frame = rawFrame as {
      functionName?: unknown;
      location?: { scriptId?: unknown; lineNumber?: unknown; columnNumber?: unknown };
    };
    const name =
      typeof frame.functionName === 'string' && frame.functionName !== ''
        ? { function: frame.functionName }
        : {};
    const url = scriptUrls.get(String(frame.location?.scriptId));
    if (url === undefined) {
      return name;
    }
    // CDP counts lines and columns from 0; a StackFrame counts from 1.
    const line = Number(frame.location?.lineNumber ?? 0) + 1;
    const column = Number(frame.location?.columnNumber ?? 0) + 1;
    return { ...parseLocation(`${url}:${line}:${column}`), ...name };
  };

  const handleReportSitePause = (params: { callFrames?: readonly unknown[] }): void => {
    const raw = params.callFrames ?? [];
    const located = raw.map(locate);
    // The SDK's own frames and the runtime's sit above the application on every one of these stacks —
    // the pause is taken from inside `logException`. Skipping them is a BUDGET decision, not a
    // correctness one: alignment ignores unmatched top frames anyway, but a scope fetched for one of
    // them is a round-trip spent inside a stopped process, and one fewer application frame captured.
    // `isUserFrame` is core's, the same predicate that sets `user` on every wire frame.
    const first = Math.max(
      located.findIndex((frame) => isUserFrame(frame)),
      0,
    );
    const chosen = located.slice(first, first + maxFrames);
    if (chosen.length === 0) {
      resume();
      return;
    }
    const collected: ReportSiteFrame[] = [];
    let pending = chosen.length;
    const settle = (index: number, frame: ReportSiteFrame): void => {
      collected[index] = frame;
      pending -= 1;
      if (pending === 0) {
        reportSite = { error: reportSiteError, frames: collected };
        resume();
      }
    };
    chosen.forEach((frame, index) => {
      const local = (
        (raw[first + index] as { scopeChain?: readonly unknown[] }).scopeChain ?? []
      ).find((entry) => (entry as { type?: string }).type === 'local') as
        | { object?: { objectId?: string } }
        | undefined;
      const objectId = local?.object?.objectId;
      if (objectId === undefined) {
        settle(index, { ...frame, locals: {} });
        return;
      }
      session.post(
        'Runtime.getProperties',
        { objectId, ownProperties: true, generatePreview: true },
        (error, result) => {
          if (error !== null) {
            onError(error);
            settle(index, { ...frame, locals: {} });
            return;
          }
          const properties = (result as { result?: readonly unknown[] } | undefined)?.result ?? [];
          settle(index, {
            ...frame,
            locals: collectScope(properties, maxVariables, maxValueLength),
          });
        },
      );
    });
  };

  session.on('Debugger.paused', (message) => {
    if (stopped) {
      resume();
      return;
    }
    // Read defensively: `params` is whatever the session handed us, and the guard below must not be the
    // thing that throws — a pause handler that throws before it reaches `resume` freezes the process.
    const reason = (message.params as { reason?: unknown } | null | undefined)?.reason;
    // The two pauses arrive through one listener. A deliberate `Debugger.pause` reports `other`; an
    // exception reports `exception` or `promiseRejection`. `awaitingReportSite` is the second half of
    // the test: a stray `other` pause is somebody else's, and consuming it would attribute a stranger's
    // stack to our next report.
    if (awaitingReportSite && reason !== 'exception' && reason !== 'promiseRejection') {
      try {
        handleReportSitePause(message.params as { callFrames?: readonly unknown[] });
      } catch (error) {
        onError(error);
        resume();
      }
      return;
    }
    notePause();
    try {
      const params = message.params as {
        callFrames?: readonly unknown[];
        data?: { objectId?: string };
      };
      const frames = (params.callFrames ?? []).slice(0, maxFrames);
      const locals: FrameLocals = [];
      let pending = frames.length;
      const thrownId = params.data?.objectId;

      const finish = (): void => {
        // Nothing to attach the locals TO without the thrown object's id — the pause and the Error the
        // SDK later captures could not be matched, so keep nothing rather than guess.
        if (thrownId !== undefined && locals.length > 0) {
          nextId += 1;
          const id = `lv${nextId}`;
          cache.set(id, locals);
          // Bounded: an application throwing continuously must not grow this without limit. Map
          // iteration is insertion-ordered, so the first key is the oldest.
          if (cache.size > maxCached) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) {
              cache.delete(oldest);
            }
          }
          try {
            session.post('Runtime.callFunctionOn', {
              objectId: thrownId,
              functionDeclaration: `function(){Object.defineProperty(this,'${MARKER}',{value:'${id}',enumerable:false,configurable:true})}`,
            });
          } catch (error) {
            onError(error);
            cache.delete(id);
          }
        }
        resume();
      };

      if (pending === 0) {
        finish();
        return;
      }
      frames.forEach((rawFrame, index) => {
        const frame = rawFrame as { scopeChain?: readonly unknown[] };
        const local = (frame.scopeChain ?? []).find(
          (scope) => (scope as { type?: string }).type === 'local',
        ) as { object?: { objectId?: string } } | undefined;
        const objectId = local?.object?.objectId;
        if (objectId === undefined) {
          pending -= 1;
          if (pending === 0) {
            finish();
          }
          return;
        }
        session.post(
          'Runtime.getProperties',
          // `generatePreview` is what makes one-level unrolling free: V8 renders the contents while
          // it is already building this response, so there is no second round-trip inside the pause.
          { objectId, ownProperties: true, generatePreview: true },
          (error, result) => {
            if (error === null) {
              const properties =
                (result as { result?: readonly unknown[] } | undefined)?.result ?? [];
              locals[index] = collectScope(properties, maxVariables, maxValueLength);
            } else {
              onError(error);
            }
            pending -= 1;
            if (pending === 0) {
              finish();
            }
          },
        );
      });
    } catch (error) {
      onError(error);
      resume(); // the guard that matters: never leave the application paused
    }
  });

  return {
    lookup(error) {
      const id = (error as Record<string, unknown> | null | undefined)?.[MARKER];
      return typeof id === 'string' ? cache.get(id) : undefined;
    },
    captureReportSite(error) {
      if (stopped || !reportSite_enabled) {
        return;
      }
      reportSite = undefined;
      reportSiteError = error;
      awaitingReportSite = true;
      try {
        // The pause lands on the NEXT statement executed, which — measured on Node 24 — is inside this
        // very `post`, so the handler has run and the process has resumed before this returns.
        session.post('Debugger.pause');
      } catch (pauseError) {
        onError(pauseError);
      }
      // Clearing here rather than in the handler covers both orderings: if the pause were to land on
      // this statement instead, the flag is still set while the handler runs.
      awaitingReportSite = false;
    },
    takeReportSite(error) {
      // Consumed. A later UNCAUGHT crash of an object that was once merely logged must not be stamped
      // with the scope it was logged from — that describes a moment which has long passed.
      if (reportSite === undefined || reportSite.error !== error) {
        return undefined;
      }
      const frames = reportSite.frames;
      reportSite = undefined;
      return frames;
    },
    stop() {
      stopped = true;
      cache.clear();
      reportSite = undefined;
      clearRecoveryTimer();
      try {
        session.post('Debugger.disable');
        session.disconnect();
      } catch (error) {
        onError(error);
      }
    },
  };
}

// A frame the runtime declines to name, in either vocabulary. A module top level is `Object.<anonymous>`
// in a V8 stack string and `''` in a CDP call frame.
const ANONYMOUS = new Set(['', '?', '<anonymous>', 'Object.<anonymous>']);

/**
 * Do a stack string's name and a call frame's name describe the same function?
 *
 * The two disagree in exactly two ways, both observed on real frames. A stack string qualifies a method
 * with its receiver (`ModuleJob.run`, `Object.handler`) where the debugger gives the bare name; and each
 * has its own spelling of "anonymous". (Sentry's `functionNamesMatch` covers the `Object.` case only;
 * the receiver is not always `Object`.)
 */
function functionNamesMatch(a: string | undefined, b: string | undefined): boolean {
  const left = a ?? '';
  const right = b ?? '';
  if (left === right) {
    return true;
  }
  if (ANONYMOUS.has(left) && ANONYMOUS.has(right)) {
    return true;
  }
  return (
    (left !== '' && right.endsWith(`.${left}`)) || (right !== '' && left.endsWith(`.${right}`))
  );
}

/** A run of two. One name in common between two stacks is a coincidence; two in a row is a stack. */
const MIN_RUN = 2;

/**
 * Attach report-site locals to the frames of the error being reported.
 *
 * The report site is the CATCH block, so from the catching function downwards the live stack and the
 * thrown error's stack are the same call chain — the error's stack merely has extra frames ABOVE, between
 * the `try` and the throw. Alignment is therefore a search for where the two overlap.
 *
 * It matches on FUNCTION NAMES and nothing else, which is not a shortcut but the only thing available.
 * Measured on Node 24: a call frame's `location` carries TRANSPILED coordinates (a whole tsx-compiled
 * file reports `lineNumber: 0`), while `Error.stack` has already been rewritten by source maps back to
 * the original file and line. Any application shipping source maps — most of them — therefore has two
 * irreconcilable vocabularies for `file` and `line`. `CallFrame.url` is no help either: it is always the
 * empty string in an in-process session.
 *
 * VERIFIED, and fails closed. The longest run of consecutive matching names wins, and a run shorter than
 * {@link MIN_RUN} attaches nothing at all — an error thrown in an earlier tick and reported from an
 * unrelated callback has no correspondence to find, and stamping this scope onto its frames would be a
 * confident lie, which is worse than the absence it replaces.
 */
export function alignReportSite(
  live: readonly ReportSiteFrame[],
  frames: readonly StackFrame[],
): StackFrame[] {
  let best: { live: number; frame: number; run: number } | undefined;
  for (let a = 0; a < live.length; a += 1) {
    for (let c = 0; c < frames.length; c += 1) {
      let run = 0;
      while (
        a + run < live.length &&
        c + run < frames.length &&
        functionNamesMatch(
          (live[a + run] as ReportSiteFrame).function,
          (frames[c + run] as StackFrame).function,
        )
      ) {
        run += 1;
      }
      if (run >= MIN_RUN && (best === undefined || run > best.run)) {
        best = { live: a, frame: c, run };
      }
    }
  }
  if (best === undefined) {
    return frames as StackFrame[];
  }
  const anchor = best;
  return frames.map((frame, index) => {
    const offset = index - anchor.frame;
    // Never overwrite what the THROW site captured: those locals are the scope as it was when the value
    // was thrown, not as it is several frames and some unwinding later.
    if (offset < 0 || offset >= anchor.run || frame.variables !== undefined) {
      return frame;
    }
    const scope = (live[anchor.live + offset] as ReportSiteFrame).locals;
    return Object.keys(scope).length === 0 ? frame : { ...frame, variables: scope };
  });
}

/**
 * Put captured locals onto the frames they belong to, top frame first.
 *
 * Returns the SAME array when there is nothing to attach, so the overwhelmingly common path — every
 * crash in a process that never paused, and every frame past the captured depth — copies nothing.
 */
export function attachLocals(
  locals: FrameLocals | undefined,
  frames: readonly StackFrame[],
): StackFrame[] {
  if (locals === undefined || locals.length === 0) {
    return frames as StackFrame[];
  }
  return frames.map((frame, index) => {
    const scope = locals[index];
    // An empty scope is not the same as no scope: a frame with genuinely no locals should not carry an
    // empty object onto the wire, so it is left alone.
    return scope === undefined || Object.keys(scope).length === 0
      ? frame
      : { ...frame, variables: scope };
  });
}

/**
 * The real `node:inspector` session, or undefined where there isn't one.
 *
 * Loaded through `createRequire` rather than a static import ON PURPOSE: `@bugsee/node`'s composition is
 * reused verbatim by the Bun and Deno tiers, and Bun's debugger support is not the same as Node's. A
 * static import would make the whole package fail to load on a runtime that lacks the module, to
 * deliver a feature that is off by default.
 */
/** Seams for {@link createInspectorSession} (tests inject both; production uses `node:inspector`). */
export interface InspectorSessionFactoryOptions {
  /** The listening inspector's URL, or undefined when none. Default `inspector.url()`. */
  inspectorUrl?: () => string | undefined;
}

/**
 * A connected-capable inspector session, or undefined when we must not take one.
 *
 * REFUSES when a debugger is already attached (`--inspect`, an IDE, another SDK). `Debugger.enable` is
 * not exclusive, but `setPauseOnExceptions` is process-wide state and last-writer-wins: attaching
 * underneath someone's live session silently changes where THEIR debugger stops, and our own
 * `Debugger.resume` — which we are otherwise right to always call — would restart a process they
 * deliberately paused. Sentry declines in the same situation for the same reason.
 *
 * The probe FAILS CLOSED: an unreadable `inspector.url()` is read as "something is there", because
 * guessing "free" attaches a second debugger to a process we know nothing about, while guessing "busy"
 * costs only the local variables.
 */
export function createInspectorSession(
  options: InspectorSessionFactoryOptions = {},
): InspectorSessionLike | undefined {
  try {
    const load = createRequire(import.meta.url);
    const inspector = load('node:inspector') as {
      Session: new () => InspectorSessionLike;
      url: () => string | undefined;
    };
    const inspectorUrl = options.inspectorUrl ?? inspector.url;
    if (inspectorUrl() !== undefined) {
      return undefined; // someone else owns the debugger
    }
    return new inspector.Session();
  } catch {
    /* v8 ignore next -- unreachable on Node, where these tests run: `node:inspector` is a builtin, so
       this is the Bun/Deno degradation path and reaching it would mean faking `createRequire` itself. */
    return undefined; // no inspector here — the capture degrades to inert
  }
}

/**
 * The {@link FrameEnricher} shape core wants, backed by a capture. Named rather than inlined at the
 * call site so the composition is a unit under test in its own right.
 */
export function createFrameEnricher(
  capture: LocalVariablesCapture,
): (error: unknown, frames: StackFrame[]) => StackFrame[] {
  // Throw site first, report site second. Both can be live at once, and where they overlap the throw
  // site wins — {@link alignReportSite} leaves an already-filled frame alone. The report site's value is
  // the frames BELOW the catch block, which the throw-site capture never reaches once `maxFrames` runs
  // out, and which are the only locals available at all when `includeCaught` is off.
  return (error, frames) =>
    alignReportSite(
      capture.takeReportSite(error) ?? [],
      attachLocals(capture.lookup(error), frames),
    );
}
