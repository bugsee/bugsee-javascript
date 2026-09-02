import { createRequire } from 'node:module';
import type { StackFrame } from '@bugsee/core';
import { isSensitiveKey, REDACTED } from '@bugsee/protocol';

// Local variables at the moment of the throw (design reference: Sentry's LocalVariables integration;
// Android has no analogue because a Java stack frame carries no locals). "It threw" becomes "it threw
// with orderId=null", which is the single biggest step-change a crash report can carry.
//
// OFF BY DEFAULT, and pause-on-UNCAUGHT only. Measured on Node 24, best-of-7 after warm-up:
//   Debugger.enable                 ~3% steady-state overhead
//   + pauseOnExceptions 'uncaught'  ~1% more (inside the noise of enable)
//   + pauseOnExceptions 'all'       ~36µs PER CAUGHT THROW
// The last number is why `includeCaught` is opt-in on top of an opt-in: an application that uses
// exceptions for control flow would pay it on every one of them.

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
  /** Test seam: the inspector session. Default a real `node:inspector` Session. */
  session?: InspectorSessionLike;
  onError?: (error: unknown) => void;
}

/** Frame-indexed locals, top frame first. */
export type FrameLocals = Array<Record<string, string>>;

export interface LocalVariablesCapture {
  /** The locals captured for `error`, or undefined if none were. */
  lookup(error: unknown): FrameLocals | undefined;
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

/** `Runtime.getProperties` describes a value; render it flat, short, and never by calling user code. */
export function renderValue(description: unknown, maxLength: number): string {
  const value = description as
    | { type?: string; value?: unknown; description?: string; subtype?: string }
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
  // `description` is V8's own rendering (e.g. "Array(3)", "function foo"). Preferring the primitive
  // `value` when present keeps numbers and booleans readable; falling back to `description` avoids
  // ever invoking a user `toString`, which could throw or have side effects.
  const rendered =
    value.value !== undefined && value.type !== 'object'
      ? String(value.value)
      : (value.description ?? String(value.type ?? 'unknown'));
  return rendered.length > maxLength ? `${rendered.slice(0, maxLength)}…` : rendered;
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
const inert: LocalVariablesCapture = { lookup: () => undefined, stop: () => {} };

export function createLocalVariablesCapture(
  options: LocalVariablesOptions = {},
): LocalVariablesCapture {
  const {
    includeCaught = false,
    maxFrames = 5,
    maxVariables = 20,
    maxValueLength = 120,
    maxCached = 20,
  } = options;
  const onError = options.onError ?? ((): void => {});
  const session = options.session;
  if (session === undefined) {
    return inert; // no session injected and no runtime probe wired yet — see `launch.ts`
  }

  const cache = new Map<string, FrameLocals>();
  let nextId = 0;
  let stopped = false;

  try {
    session.connect();
    session.post('Debugger.enable');
    session.post('Debugger.setPauseOnExceptions', {
      state: includeCaught ? 'all' : 'uncaught',
    });
  } catch (error) {
    onError(error);
    return inert;
  }

  // ALWAYS reached, on every path out of a pause. A debugger that pauses and never resumes freezes the
  // application — which is the one outcome strictly worse than having no local variables at all.
  const resume = (): void => {
    try {
      session.post('Debugger.resume');
    } catch (error) {
      onError(error);
    }
  };

  session.on('Debugger.paused', (message) => {
    if (stopped) {
      resume();
      return;
    }
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
          { objectId, ownProperties: true },
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
    stop() {
      stopped = true;
      cache.clear();
      try {
        session.post('Debugger.disable');
        session.disconnect();
      } catch (error) {
        onError(error);
      }
    },
  };
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
export function createInspectorSession(): InspectorSessionLike | undefined {
  try {
    const load = createRequire(import.meta.url);
    const { Session } = load('node:inspector') as { Session: new () => InspectorSessionLike };
    return new Session();
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
  return (error, frames) => attachLocals(capture.lookup(error), frames);
}
