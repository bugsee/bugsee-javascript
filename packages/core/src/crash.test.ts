import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildCrashJson,
  type CrashJson,
  type NativeCrashJson,
  stampCrashProvenance,
} from './crash';
import { parseV8Stack, type StackFrame } from './stack';

function errorWith(name: string, message: string, stack: string | undefined): Error {
  const e = new Error(message);
  e.name = name;
  e.stack = stack;
  return e;
}

describe('buildCrashJson', () => {
  it('builds the Android-parity container from an Error (name/reason/structured frames)', () => {
    const err = errorWith(
      'TypeError',
      'Cannot read x',
      'TypeError: Cannot read x\n    at handleClick (app.min.js:1:2345)\n    at onClick (app.min.js:1:1200)',
    );
    const crash = buildCrashJson(err, { parseStack: parseV8Stack, handled: true });
    expect(crash).toBeDefined();
    expect(crash?.exception_type).toBe('error');
    expect(crash?.ndkCrash).toBe(false);
    expect(crash?.handled).toBe(true);
    expect(crash?.exception.name).toBe('TypeError');
    expect(crash?.exception.reason).toBe('Cannot read x');
    expect(crash?.exception.frames).toHaveLength(2);
    const f0 = crash?.exception.frames[0];
    expect(f0?.trace).toBe('at handleClick (app.min.js:1:2345)'); // no debugId suffix — it's a separate field
    expect(f0?.user).toBe(true);
    expect(f0?.data).toEqual({
      source: 'app.min.js',
      member: 'handleClick',
      line: 1,
      column: 2345,
    });
    expect(f0?.debug_id).toBeUndefined(); // no build injected one
  });

  it('stamps per-frame debug_id from the registration global', () => {
    const registrationStack = 'Error\n    at app.min.js:1:1'; // top frame file = app.min.js
    const globalObject = { _bugseeDebugIds: { [registrationStack]: 'dbg-uuid' } };
    const err = errorWith('Error', 'boom', 'Error: boom\n    at handleClick (app.min.js:1:2345)');
    const crash = buildCrashJson(err, { parseStack: parseV8Stack, globalObject });
    expect(crash?.exception.frames[0]?.debug_id).toBe('dbg-uuid');
  });

  it('recurses the cause chain', () => {
    const inner = errorWith('RangeError', 'inner', 'RangeError: inner\n    at f (a.js:2:2)');
    const outer = errorWith('Error', 'outer', 'Error: outer\n    at g (b.js:3:3)');
    (outer as { cause?: unknown }).cause = inner;
    const crash = buildCrashJson(outer, { parseStack: parseV8Stack });
    expect(crash?.exception.cause?.name).toBe('RangeError');
    expect(crash?.exception.cause?.frames[0]?.trace).toBe('at f (a.js:2:2)');
  });

  it('guards a cause CYCLE (self-cause does not recurse / loop)', () => {
    const err = errorWith('Error', 'x', 'Error: x\n    at f (a.js:1:1)');
    (err as { cause?: unknown }).cause = err;
    const crash = buildCrashJson(err, { parseStack: parseV8Stack });
    expect(crash?.exception.cause).toBeUndefined();
  });

  it('caps the cause chain at 10 levels', () => {
    // Build 12 chained errors; the 11th cause (depth 10) must not be attached.
    let tip = errorWith('Error', 'e12', 'Error: e12\n    at f (a.js:12:1)');
    for (let i = 11; i >= 1; i -= 1) {
      const outer = errorWith('Error', `e${i}`, `Error: e${i}\n    at f (a.js:${i}:1)`);
      (outer as { cause?: unknown }).cause = tip;
      tip = outer;
    }
    let node = buildCrashJson(tip, { parseStack: parseV8Stack })?.exception;
    let depth = 0;
    while (node?.cause) {
      node = node.cause;
      depth += 1;
    }
    expect(depth).toBe(10); // 10 causes attached, the 11th dropped
  });

  it('defaults handled to false', () => {
    const err = errorWith('Error', 'x', 'Error: x\n    at f (a.js:1:1)');
    expect(buildCrashJson(err, { parseStack: parseV8Stack })?.handled).toBe(false);
  });

  describe('frame attribution', () => {
    const framesOf = (stack: string): Array<{ trace: string; user: boolean }> =>
      (buildCrashJson(errorWith('Error', 'x', stack), { parseStack: parseV8Stack }) as CrashJson)
        .exception.frames;

    it("marks the SDK's own frames as not the user's", () => {
      // The SDK sits between the throw and the capture, so its frames are ALWAYS on the stack. Calling
      // them the user's puts SDK internals at the top of every trace and feeds them into grouping.
      const frames = framesOf(
        [
          'Error: x',
          '    at handler (/app/src/routes.ts:10:5)',
          '    at run (/app/node_modules/@bugsee/node/dist/index.js:776:12)',
          '    at Object.run (/app/node_modules/.pnpm/@bugsee+core@0.1.0/node_modules/@bugsee/core/dist/index.cjs:5:1)',
        ].join('\n'),
      );
      expect(frames.map((f) => f.user)).toEqual([true, false, false]);
    });

    it("marks node internals as not the user's", () => {
      const frames = framesOf(
        [
          'Error: x',
          '    at handler (/app/src/routes.ts:10:5)',
          '    at Server.emit (node:events:509:28)',
          '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
        ].join('\n'),
      );
      expect(frames.map((f) => f.user)).toEqual([true, false, false]);
    });

    it("does not mistake an application path that merely mentions bugsee for the SDK's", () => {
      const frames = framesOf(
        [
          'Error: x',
          '    at f (/app/src/bugsee-client.ts:3:1)',
          '    at g (/app/src/@bugsee.ts:1:1)',
        ].join('\n'),
      );
      expect(frames.map((f) => f.user)).toEqual([true, true]);
    });

    it("treats a frame with no file as the user's", () => {
      expect(framesOf('Error: x\n    at <anonymous>').every((f) => f.user)).toBe(true);
    });
  });

  describe('non-Error throwables', () => {
    // JS code throws non-Errors routinely, and `logException` accepts them. They used to produce NO
    // crash.json at all, so the uploaded bundle had a summary and nothing else and the backend
    // answered "Crash data for the issue was not found" — an issue that exists, is counted, and
    // cannot be acted on. A synthetic exception keeps the report usable.
    it.each([
      ['a string throwable', 'String', 'a string throwable'],
      [42, 'Number', '42'],
      [true, 'Boolean', 'true'],
      [null, 'Null', 'null'],
      [undefined, 'Undefined', 'undefined'],
      [Symbol.iterator, 'Symbol', 'Symbol(Symbol.iterator)'],
    ])('synthesises an exception for %s', (value, name, reason) => {
      const crash = buildCrashJson(value);
      expect(crash?.exception.name).toBe(name);
      expect(crash?.exception.reason).toBe(reason);
      expect(crash?.exception_type).toBe('error');
    });

    it('renders a plain object with no message as JSON, so its fields survive', () => {
      const crash = buildCrashJson({ code: 'E_SCENARIO', status: 503 });
      expect(crash?.exception.name).toBe('Object');
      expect(crash?.exception.reason).toBe('{"code":"E_SCENARIO","status":503}');
    });

    it("prefers a thrown object's own `message` over the JSON rendering", () => {
      const crash = buildCrashJson({ code: 'E_SCENARIO', message: 'object throwable' });
      expect(crash?.exception.reason).toBe('object throwable');
    });

    it("uses a thrown object's own `name`/`message` when it has them (an Error-like)", () => {
      const crash = buildCrashJson({ name: 'HttpError', message: 'timeout' });
      expect(crash?.exception.name).toBe('HttpError');
      expect(crash?.exception.reason).toBe('timeout');
    });

    it('survives a value that cannot be stringified', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const crash = buildCrashJson(circular);
      expect(crash?.exception.name).toBe('Object');
      expect(typeof crash?.exception.reason).toBe('string'); // rendered, not thrown on
    });

    it('carries the class name of a thrown non-Error instance', () => {
      class Boom {}
      expect(buildCrashJson(new Boom())?.exception.name).toBe('Boom');
    });

    it('honours `handled`, exactly as it does for an Error', () => {
      expect(buildCrashJson('x', { handled: true })?.handled).toBe(true);
      expect(buildCrashJson('x')?.handled).toBe(false);
    });
  });

  it('omits reason when the error has no message', () => {
    const err = errorWith('Error', '', 'Error\n    at f (a.js:1:1)');
    expect(buildCrashJson(err, { parseStack: parseV8Stack })?.exception.reason).toBeUndefined();
  });

  it('defaults the name to Error when absent', () => {
    const err = errorWith('', 'x', 'Error: x\n    at f (a.js:1:1)');
    expect(buildCrashJson(err, { parseStack: parseV8Stack })?.exception.name).toBe('Error');
  });

  it('handles an error with no stack (empty frames)', () => {
    const err = errorWith('Error', 'x', undefined);
    // default parseStack (parseV8Stack) + default global — a bare env has no injected debug-ids.
    expect(buildCrashJson(err)?.exception.frames).toEqual([]);
  });

  it('omits data for a frame with no scrubbable fields (custom parser) + renders a bare trace', () => {
    const emptyParser = (_stack: string): StackFrame[] => [{}];
    const err = errorWith('Error', 'x', 'whatever');
    const f = buildCrashJson(err, { parseStack: emptyParser })?.exception.frames[0];
    expect(f?.data).toBeUndefined();
    expect(f?.trace).toBe('at <anonymous> (<unknown>)');
    expect(f?.user).toBe(true);
  });
});

// WAVE 5.4(a) — the `source_*` provenance triple, so a crash.json is SELF-DESCRIBING.
//
// The backend picks a per-SDK crash processor. It used to read `environment.sdk.type` back out of the
// PERSISTED recording, which made JS routing depend on a field the appserver's schema silently dropped —
// every JS crash reached the generic `managed` processor instead. The appserver schema is now fixed, but
// the deeper problem is structural and the fallback cannot solve it: `crash.json` and `environment` do not
// travel together. On the resymbolication path the crash is read from object storage while the environment
// comes from a separate database read, so a crash that carries no provenance of its own is unroutable
// whenever that environment is missing or partial.
//
// Rust already emits the triple; this is the JS adoption. Per report-bundle-structure:
//   - `source_sdk`      — the routing key. Consumers branch on it BEFORE looking at platform.type.
//   - `source_platform` — the platform fallback when the fetched environment carries none.
//   - `source_arch`     — OMITTED here. The MIRROR RULE says a producer emits only what its environment
//                         already states, and the JS SDK reports no `hardware.arch` at all. Inventing one
//                         would reintroduce exactly the drift the triple exists to eliminate.
//
// The mirror rule is also why this is a stamping step over the built environment rather than a probe:
// both values are COPIES of what `request.json` emits, so the two cannot disagree by construction.
describe('stampCrashProvenance', () => {
  const env: EnvironmentEnvelope = {
    platform: { type: 'node', version: '22.1.0' },
    sdk: { version: '1.2.3', type: 'javascript' },
  };
  const crash: CrashJson = {
    exception_type: 'error',
    ndkCrash: false,
    handled: false,
    exception: { name: 'TypeError', frames: [] },
  };

  it('emits source_sdk javascript for the SDK’s own environment', () => {
    expect(stampCrashProvenance(crash, env).source_sdk).toBe('javascript');
  });

  it('COPIES source_sdk out of the environment rather than hard-coding the literal', () => {
    // `EnvironmentEnvelope.sdk.type` is typed as the literal 'javascript', so no honest fixture can hold a
    // different value and the assertion above passes just as happily against `source_sdk: 'javascript'`
    // written inline — verified by injecting exactly that, which survived every other test in this file.
    //
    // The cast is the point: it forces the one question the type system hides. If the family string ever
    // gains a second value (an Electron-specific tag, a wrapper SDK identifying itself), a hard-coded stamp
    // silently keeps claiming 'javascript' and the crash routes to the wrong processor — the exact class of
    // failure the mirror rule exists to prevent.
    const future = {
      ...env,
      sdk: { ...env.sdk, type: 'javascript-next' },
    } as unknown as EnvironmentEnvelope;
    expect(stampCrashProvenance(crash, future).source_sdk).toBe('javascript-next');
  });

  it('copies source_platform from the environment', () => {
    expect(stampCrashProvenance(crash, env).source_platform).toBe('node');
  });

  it('tracks the platform per runtime instead of assuming one', () => {
    // The value is a copy, so every runtime the SDK supports must come through as ITSELF. A constant here
    // would satisfy the two assertions above while making the field useless as a platform fallback.
    const platforms = ['web', 'electron-renderer', 'workers', 'service-worker'] as const;
    for (const type of platforms) {
      const scoped: EnvironmentEnvelope = { ...env, platform: { type, version: '1' } };
      expect(stampCrashProvenance(crash, scoped).source_platform).toBe(type);
    }
  });

  it('omits source_arch — the JS SDK reports no hardware.arch to mirror', () => {
    expect(stampCrashProvenance(crash, env)).not.toHaveProperty('source_arch');
  });

  it('preserves every field of the crash it stamps', () => {
    // Provenance is ADDITIVE. Dropping the exception while adding the markers would produce a document
    // that routes perfectly and symbolicates nothing.
    expect(stampCrashProvenance(crash, env)).toMatchObject(crash);
  });

  it('does not mutate the crash it was given', () => {
    // The Report holds this object, and a report can be assembled more than once (recovery re-assembles a
    // drained capture). Stamping in place would make the second assembly read a mutated input.
    // JSON round-trip rather than structuredClone: core compiles with no DOM/Node lib.
    const original = JSON.parse(JSON.stringify(crash)) as CrashJson;
    stampCrashProvenance(crash, env);
    expect(crash).toEqual(original);
  });

  it('stamps a NATIVE crash the same way, keeping its minidump reference', () => {
    // The native variant is a different shape (no `exception`, carries `minidumpFile`) and routes through
    // the same branch — a JS/Electron Crashpad dump is claimed by `javascript.process_crash_report`.
    const native: NativeCrashJson = {
      exception_type: 'native',
      ndkCrash: true,
      minidumpFile: 'dump-1.dmp',
    };
    const stamped = stampCrashProvenance(native, {
      ...env,
      platform: { type: 'electron-main', version: '30' },
    });
    expect(stamped.source_sdk).toBe('javascript');
    expect(stamped.source_platform).toBe('electron-main');
    expect(stamped.minidumpFile).toBe('dump-1.dmp');
  });
});
