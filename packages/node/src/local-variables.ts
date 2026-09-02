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
  return (error, frames) => attachLocals(capture.lookup(error), frames);
}
