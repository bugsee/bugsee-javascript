import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_PARAMS, EventName, TRACE_SPEC, TraceName } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  discoverProducerFiles,
  literalOffenders,
  registryReferences,
  traceEmitStyles,
} from './support/spec-drift-lib';

// SPEC-CONFORMANCE GUARD (gap items C17 + C24). The JavaScript platform spec (bugsee/specs
// `sdk/reporting/platforms/javascript.md`) fixes the names, value types, units and param keys the SDK writes into
// `traces.system` / `events.system`. A snapshot of its tables is vendored at
// `packages/protocol/spec/javascript-system-traces.snapshot.json` (refresh: `pnpm spec:refresh`, which records the spec
// commit) and this file fails CI when the SDK drifts from it:
//   1. the registry (`@bugsee/protocol` system-names.ts) is a subset of the spec, with the same metadata;
//   2. every spec name is registered, or listed in NOT_YET below with the reason it is not emitted;
//   3. every registered name is reached by a producer through the registry (so it really is emitted);
//   4. producer code never spells a registered name as a literal (one place per wire name), nor a retired one.

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, '..', '..');
const SNAPSHOT_PATH = join(PACKAGES, 'protocol', 'spec', 'javascript-system-traces.snapshot.json');

interface Snapshot {
  source: { repo: string; path: string; commit: string; committed: string };
  traces: Array<{
    name: string;
    families: string[];
    pending: string[];
    valueType: string;
    unit: string | null;
    held: boolean;
  }>;
  events: Array<{ name: string; families: string[]; pending: string[]; params: string[] }>;
  retired: string[];
  notEmitted: string[];
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;

/**
 * Names the spec lists that the SDK does not emit YET. Each maps to the spec's own pending item, so the entry goes away
 * (and this test demands it) the day the producer lands. Keep it the SHORTEST list possible: an entry here is a known gap.
 */
const NOT_YET: Readonly<Record<string, string>> = {
  route: 'C12: no client.setRoute / adapter route hook yet (spec: pending, P1)',
  view: 'C12: no client.setView / adapter view hook yet (spec: pending, P1)',
  thermal_state: 'C13: Electron main thermal state (macOS) not built (spec: pending, P2)',
  cpu_speed_limit: 'C13: Electron main speed limit not built (spec: proposed, pending, P2)',
};

/**
 * JS-ONLY extensions: registered names the spec does not document at all. EMPTY on purpose: a JS-specific name belongs
 * in the spec (the spec marks those "JS-specific") before the SDK emits it. Adding one here needs a reason AND a spec issue.
 */
const JS_ONLY_EXTENSIONS: Readonly<Record<string, string>> = {};

const specTraces = new Map(snapshot.traces.map((t) => [t.name, t]));
const specEvents = new Map(snapshot.events.map((e) => [e.name, e]));
const registeredTraces = Object.values(TraceName) as string[];
const registeredEvents = Object.values(EventName) as string[];

const producerFiles = discoverProducerFiles(PACKAGES);
const sources = new Map(producerFiles.map((f) => [f, readFileSync(join(PACKAGES, f), 'utf8')]));

describe('vendored spec snapshot', () => {
  it('records the bugsee/specs commit it was generated from', () => {
    expect(snapshot.source.repo).toBe('bugsee/specs');
    expect(snapshot.source.path).toBe('sdk/reporting/platforms/javascript.md');
    expect(snapshot.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(snapshot.source.committed))).toBe(false);
  });

  it('is not vacuous', () => {
    expect(snapshot.traces.length).toBeGreaterThan(40);
    expect(snapshot.events.length).toBeGreaterThan(30);
    expect(snapshot.retired).toContain('screen_size');
    expect(snapshot.notEmitted).toContain('fps_max');
  });
});

describe('traces: registry vs spec', () => {
  it('every registered trace is in the spec, or a documented JS-only extension', () => {
    const unknown = registeredTraces.filter(
      (n) => !specTraces.has(n) && !(n in JS_ONLY_EXTENSIONS),
    );
    expect(unknown).toEqual([]);
  });

  it('every spec trace is registered, or listed as not yet emitted (with the reason)', () => {
    const missing = [...specTraces.keys()].filter(
      (n) => !registeredTraces.includes(n) && !(n in NOT_YET),
    );
    expect(missing).toEqual([]);
  });

  it('NOT_YET names are still in the spec, still marked pending there, and not registered', () => {
    for (const [name, reason] of Object.entries(NOT_YET)) {
      expect(reason.length, name).toBeGreaterThan(10);
      const spec = specTraces.get(name);
      expect(spec, `${name} left the spec: drop it from NOT_YET`).toBeDefined();
      expect(spec?.pending.length, `${name} is no longer pending in the spec`).toBeGreaterThan(0);
      expect(registeredTraces, `${name} is registered: drop it from NOT_YET`).not.toContain(name);
    }
  });

  it('value type, unit and held-ness of every registered trace equal the spec', () => {
    for (const name of registeredTraces) {
      const spec = specTraces.get(name);
      if (spec === undefined) continue; // a JS-only extension: nothing to compare with
      const ours = TRACE_SPEC[name as TraceName];
      expect({ name, ...ours }).toEqual({
        name,
        valueType: spec.valueType,
        unit: spec.unit,
        held: spec.held,
      });
    }
  });

  it('no retired or mobile-only name is registered', () => {
    for (const name of registeredTraces) {
      expect(snapshot.retired, name).not.toContain(name);
      expect(snapshot.notEmitted, name).not.toContain(name);
    }
  });
});

describe('events: registry vs spec', () => {
  it('every registered event is in the spec, or a documented JS-only extension', () => {
    expect(
      registeredEvents.filter((n) => !specEvents.has(n) && !(n in JS_ONLY_EXTENSIONS)),
    ).toEqual([]);
  });

  it('every spec event is registered (no event is pending today)', () => {
    expect([...specEvents.keys()].filter((n) => !registeredEvents.includes(n))).toEqual([]);
  });

  it('param keys of every registered event equal the spec', () => {
    for (const name of registeredEvents) {
      const spec = specEvents.get(name);
      if (spec === undefined) continue;
      expect([...EVENT_PARAMS[name as EventName]].sort(), name).toEqual([...spec.params].sort());
    }
  });

  it('no retired or mobile-only name is registered', () => {
    for (const name of registeredEvents) expect(snapshot.notEmitted, name).not.toContain(name);
  });
});

describe('JS-only extension allow-list', () => {
  it('only holds names that are registered, each with a reason', () => {
    for (const [name, reason] of Object.entries(JS_ONLY_EXTENSIONS)) {
      expect([...registeredTraces, ...registeredEvents], name).toContain(name);
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});

describe('producers use the registry, and only the registry', () => {
  const registered = new Set([...registeredTraces, ...registeredEvents]);
  const forbidden = new Set([...registered, ...snapshot.retired]);

  it('finds the known producer files (the discovery is not vacuous)', () => {
    for (const file of [
      'browser/src/trace-producers.ts',
      'browser/src/system-events.ts',
      'browser/src/url-producer.ts',
      'node/src/trace-producers.ts',
      'node/src/system-events.ts',
      'node/src/disk-space-producer.ts',
      'electron/src/system-traces.ts',
      'electron/src/system-events.ts',
      'capture/src/capture-state-producer.ts',
      'browser/src/launch.ts',
      'electron/src/launch-renderer.ts',
      'webview/src/launch.ts',
    ]) {
      expect(producerFiles, file).toContain(file);
    }
  });

  it('no producer file spells a registered (or retired) name as a string literal', () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      for (const o of literalOffenders(source, forbidden)) {
        offenders.push(`${file}:${o.line} '${o.text}' (${o.why})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every registered trace and event is reached through the registry by some producer', () => {
    const traces = new Set<string>();
    const events = new Set<string>();
    for (const source of sources.values()) {
      const refs = registryReferences(source);
      for (const k of refs.traces) traces.add(k);
      for (const k of refs.events) events.add(k);
    }
    const keyOf = (obj: Record<string, string>, wire: string): string =>
      Object.keys(obj).find((k) => obj[k] === wire) as string;
    expect(registeredTraces.filter((n) => !traces.has(keyOf(TraceName, n)))).toEqual([]);
    expect(registeredEvents.filter((n) => !events.has(keyOf(EventName, n)))).toEqual([]);
  });
});

describe('held-ness: the spec column vs the emit call', () => {
  it('every producer sends each registered trace with the style the spec gives it', () => {
    const wrong: string[] = [];
    const seen = new Set<string>();
    for (const [file, source] of sources) {
      for (const [key, styles] of traceEmitStyles(source)) {
        seen.add(key);
        const wire = TraceName[key as keyof typeof TraceName];
        const held = TRACE_SPEC[wire].held;
        for (const style of styles) {
          if ((style === 'emitIfChanged') !== held) {
            wrong.push(`${file}: ${key} is sent with ${style}, spec says held=${held}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    // every trace is sent through a recognised emit call (a producer writing through some other path would escape this check)
    expect(Object.keys(TraceName).filter((k) => !seen.has(k))).toEqual([]);
  });
});

describe('traceEmitStyles (the scanner itself)', () => {
  it('reads emit, emitIfChanged and the publishTime helper, with a private or public callee', () => {
    const styles = traceEmitStyles(`
      this.emit(TraceName.A, 1);
      this.emitIfChanged(TraceName.B, 2);
      this.#publishTime(TraceName.C, 3);
      this.emit(TraceName.A, 4);
      this.emitIfChanged(TraceName.A, 5);
    `);
    expect([...(styles.get('A') ?? [])].sort()).toEqual(['emit', 'emitIfChanged']);
    expect([...(styles.get('B') ?? [])]).toEqual(['emitIfChanged']);
    expect([...(styles.get('C') ?? [])]).toEqual(['emit']);
  });

  it('ignores other callees, literals, other objects and a bare function call', () => {
    expect(
      traceEmitStyles(`
      this.send(TraceName.A, 1);
      this.emit('literal', 1);
      this.emit(Other.A, 1);
      this.emit(TraceName['A'], 1);
      this.emit(x.TraceName.A, 1);
      this.emit();
      emit(TraceName.A, 1);
    `).size,
    ).toBe(0);
  });
});

describe('literalOffenders (the scanner itself)', () => {
  const names = new Set(['battery', 'power_ac', 'power_battery', 'process_started', 'orientation']);

  it('flags a registered name as an argument, a property value and a comparison', () => {
    expect(literalOffenders("this.emit('battery', 1);", names)).toHaveLength(1);
    expect(literalOffenders("send({ name: 'process_started' });", names)).toHaveLength(1);
    expect(literalOffenders('const n = `process_started`;', names)).toHaveLength(1);
    expect(literalOffenders("hostOwned.includes('battery')", names)[0]).toMatchObject({
      line: 1,
      text: 'battery',
    });
  });

  it('reports the line', () => {
    expect(literalOffenders("\n\nemit('battery');", names)[0]?.line).toBe(3);
  });

  it('does not flag a comparison or a case label: reading a string is not writing a wire name', () => {
    expect(literalOffenders("if (x === 'battery') {}", names)).toEqual([]);
    expect(literalOffenders("if (x !== 'battery') {}", names)).toEqual([]);
    expect(literalOffenders("if (x == 'battery') {}", names)).toEqual([]);
    expect(literalOffenders("if (x != 'battery') {}", names)).toEqual([]);
    expect(literalOffenders("switch (x) { case 'battery': break; }", names)).toEqual([]);
    expect(literalOffenders("if (x && 'battery') {}", names)).toHaveLength(1); // not a comparison
  });

  it('does not flag a name the registry does not know', () => {
    expect(literalOffenders("emit('unknown_thing');", names)).toEqual([]);
  });

  it('exempts tracker stage keys, type positions, imports and the producer id', () => {
    expect(literalOffenders("tracker.on('orientation', cb);", names)).toEqual([]);
    expect(literalOffenders("tracker.off('orientation', cb);", names)).toEqual([]);
    expect(literalOffenders("tracker.once('orientation', cb);", names)).toEqual([]);
    expect(literalOffenders("tracker.current('orientation');", names)).toEqual([]);
    expect(literalOffenders("env.onAny('orientation');", names)).toEqual([]);
    expect(literalOffenders("type Stage = 'orientation';", names)).toEqual([]);
    expect(literalOffenders("import x from 'battery';", names)).toEqual([]);
    expect(literalOffenders("export * from 'battery';", names)).toEqual([]);
    expect(literalOffenders("class P { readonly name = 'battery'; }", names)).toEqual([]);
  });

  it('does not exempt a non-tracker call or a property that is not the producer id', () => {
    expect(literalOffenders("tracker.emit('orientation');", names)).toHaveLength(1);
    expect(literalOffenders("emit('orientation');", names)).toHaveLength(1);
    expect(literalOffenders("class P { readonly kind = 'battery'; }", names)).toHaveLength(1);
    expect(literalOffenders("class P { ['name'] = 'battery'; }", names)).toHaveLength(1);
  });

  it('flags a wire name assembled from a shared prefix, but not an unrelated template', () => {
    expect(literalOffenders('send(`power_${state}`);', names)).toHaveLength(1);
    expect(literalOffenders('send(`other_${state}`);', names)).toEqual([]);
    expect(literalOffenders('send(`process_${state}`);', names)).toEqual([]); // one name only: not a family
    expect(literalOffenders('send(`${state}`);', names)).toEqual([]);
  });
});

describe('registryReferences (the scanner itself)', () => {
  it('collects TraceName.X and EventName.X accesses, nothing else', () => {
    const refs = registryReferences(
      'emit(TraceName.BATTERY); send(EventName.GC); Other.BATTERY; TraceName["x"]; a.TraceName.Y;',
    );
    expect([...refs.traces]).toEqual(['BATTERY']);
    expect([...refs.events]).toEqual(['GC']);
  });
});

describe('discoverProducerFiles (the scanner itself)', () => {
  it('finds product sources that build producers, system-event sources or the host-owned list, and nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'producer-discovery-'));
    try {
      const put = (rel: string, text: string): void => {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
      };
      put('b/src/p.ts', 'class P extends TraceProducerBase {}');
      put('a/src/deep/events.ts', 'const e: SystemEvent = x;');
      put('a/src/launch.ts', 'const o = { hostOwnedTraces: [] };');
      put('a/src/plain.ts', 'export const x = 1;');
      put('a/src/p.test.ts', 'TraceProducerBase');
      put('a/src/p.test-d.ts', 'TraceProducerBase');
      put('a/src/p.d.ts', 'TraceProducerBase');
      put('a/src/notts.js', 'TraceProducerBase');
      put('a/src/node_modules/m.ts', 'TraceProducerBase');
      put('a/src/dist/m.ts', 'TraceProducerBase');
      put('a/src/coverage/m.ts', 'TraceProducerBase');
      put('a/src/.turbo/m.ts', 'TraceProducerBase');
      put('a/test/t.ts', 'TraceProducerBase'); // not under src
      put('protocol/src/names.ts', 'TraceProducerBase'); // the registry's own package
      put('instrumentation-tests/src/x.ts', 'TraceProducerBase'); // this harness
      put('loose-file.ts', 'TraceProducerBase'); // a file, not a package
      put('nosrc/readme.md', 'TraceProducerBase'); // a package with no src
      put('a/src/word.ts', 'const MyTraceProducerBaseX = 1; const SystemEventful = 2;'); // word boundary
      expect(discoverProducerFiles(root).sort()).toEqual([
        join('a', 'src', 'deep', 'events.ts'),
        join('a', 'src', 'launch.ts'),
        join('b', 'src', 'p.ts'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
