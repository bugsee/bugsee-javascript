import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_PARAMS, EventName, TRACE_SPEC, TraceName } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  discoverSourceFiles,
  dynamicRegistryLookups,
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
 * Names the spec lists that the SDK does not emit YET. Each names the spec's own pending item (it must still be the
 * pending marker on that row of the snapshot) and the issue/PR tracking the work, so the entry cannot outlive the work:
 * the day the producer lands the name is registered and this test demands the entry go. Keep it the SHORTEST list possible.
 */
const NOT_YET: Readonly<
  Record<string, { spec: string; tracking: readonly number[]; reason: string }>
> = {
  route: {
    spec: 'C12',
    tracking: [126, 134],
    reason: 'no client.setRoute / adapter route hook yet',
  },
  view: { spec: 'C12', tracking: [126, 134], reason: 'no client.setView / adapter view hook yet' },
};

/**
 * Files that contain a spec name as a string WITHOUT writing it to a system stream (the scan reads every product file).
 * Each entry needs the reason, and goes stale (and fails) when the file no longer has such a string, so the list only shrinks.
 */
const NOT_A_WIRE_NAME: Readonly<Record<string, string>> = {
  'browser/src/navigation-source.ts':
    "the navigation source KIND 'url' (vs an adapter's programmatic one)",
  'browser-utils/src/coexistence.ts': "a directory/key segment named 'capture'",
  'capture/src/detector-url-sanitizer.ts': "the sanitizer's 'url' kind",
  'electron/src/main-control.ts': "the control-channel command 'resume'",
  'electron/src/protocol.ts': "the control-channel command 'resume'",
  'node/src/instance-layout.ts': "the on-disk subdirectory 'capture'",
  'node/src/recover-instances.ts': "the on-disk subdirectory 'capture'",
  'performance/src/controller.ts': "the transaction source 'route'/'url'",
  'trackers/src/browser/application-tracker.ts':
    'tracker stage keys (freeze/resume), not wire names',
  'trackers/src/browser/connectivity-tracker.ts': 'tracker states (online/offline), not wire names',
  'trackers/src/browser/ui-tracker.ts': 'tracker stage key (orientation), not a wire name',
  'trackers/src/electron/display-tracker.ts': 'tracker stage key (displays), not a wire name',
  'trackers/src/electron/power-tracker.ts': 'power-monitor event/source names, not wire names',
  'trackers/src/node/gc-observer.ts': "the PerformanceObserver entry type 'gc'",
  'trackers/src/node/process-tracker.ts': 'tracker stage key (gc), not a wire name',
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

// EVERY product source file (packages/*/src, minus protocol where the registry lives): a producer is found by what it
// contains, not by what it mentions, so a file that holds nothing but a list of names is scanned like any other.
const productFiles = discoverSourceFiles(PACKAGES);
const sources = new Map(productFiles.map((f) => [f, readFileSync(join(PACKAGES, f), 'utf8')]));

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

  it('NOT_YET names are still in the spec, pending under the item they cite, tracked, and not registered', () => {
    for (const [name, entry] of Object.entries(NOT_YET)) {
      expect(entry.reason.length, name).toBeGreaterThan(10);
      expect(entry.tracking.length, `${name} has no issue/PR`).toBeGreaterThan(0);
      for (const n of entry.tracking) expect(Number.isInteger(n) && n > 0, name).toBe(true);
      const spec = specTraces.get(name);
      expect(spec, `${name} left the spec: drop it from NOT_YET`).toBeDefined();
      expect(spec?.pending, `${name}: the spec's pending item is not ${entry.spec}`).toContain(
        entry.spec,
      );
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

describe('product code uses the registry, and only the registry', () => {
  const registered = new Set([...registeredTraces, ...registeredEvents]);
  // EVERY name the spec knows, pending ones included (`'route' as TraceName` must not slip through), and the retired ones
  const forbidden = new Set([...specTraces.keys(), ...specEvents.keys(), ...snapshot.retired]);

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
      'core/src/disk-pressure-backend.ts',
      'browser/src/launch.ts',
      'electron/src/launch-renderer.ts',
      'webview/src/launch.ts',
    ]) {
      expect([...sources.keys()], file).toContain(file);
    }
    expect([...sources.keys()].some((f) => f.startsWith('protocol/'))).toBe(false);
  });

  it('no product file spells a spec name as a string literal, or builds one by concatenation', () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      if (file in NOT_A_WIRE_NAME) continue;
      for (const o of literalOffenders(source, forbidden)) {
        offenders.push(`${file}:${o.line} '${o.text}' (${o.why})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every NOT_A_WIRE_NAME entry still has a string it excuses (the list only shrinks)', () => {
    for (const [file, reason] of Object.entries(NOT_A_WIRE_NAME)) {
      expect(reason.length, file).toBeGreaterThan(10);
      const source = sources.get(file);
      expect(source, `${file} is gone: drop it from NOT_A_WIRE_NAME`).toBeDefined();
      expect(
        literalOffenders(source ?? '', forbidden).length,
        `${file} no longer needs its exemption`,
      ).toBeGreaterThan(0);
    }
  });

  it('nothing reads the registry with a computed key (TraceName[key] defeats the reference check)', () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      for (const o of dynamicRegistryLookups(source)) offenders.push(`${file}:${o.line} ${o.text}`);
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
    expect(registered.size).toBe(registeredTraces.length + registeredEvents.length);
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

  it('flags a name quoted inside a longer string (a hand-built JSON probe)', () => {
    expect(literalOffenders(`const p = '"name":"battery","value"';`, names)).toHaveLength(1);
    expect(literalOffenders('const p = \'"orientation"\';', names)).toHaveLength(1);
    expect(literalOffenders("const p = 'battery pack';", names)).toEqual([]); // a word, not a quoted name
    expect(literalOffenders('const p = `"name":"${x}"`;', names)).toEqual([]);
  });

  it('flags every way of assembling a prefixed name: +, join, and a shared-suffix template', () => {
    expect(literalOffenders("send('power_' + state);", names)).toHaveLength(1);
    expect(
      literalOffenders("send(state + '_changed');", new Set(['a_changed', 'b_changed'])),
    ).toHaveLength(1);
    expect(literalOffenders("send(['power', s].join('_'));", names)).toHaveLength(1);
    expect(
      literalOffenders('send(`${kind}_changed`);', new Set(['a_changed', 'b_changed'])),
    ).toHaveLength(1);
    // not name-shaped: an unrelated prefix/suffix, a single-name prefix, a non-underscore join
    expect(literalOffenders("send('other_' + state);", names)).toEqual([]);
    expect(literalOffenders('send(a + b);', names)).toEqual([]);
    expect(literalOffenders("send(['power', s].join('-'));", names)).toEqual([]);
    expect(literalOffenders("send(['other', s].join('_'));", names)).toEqual([]);
    expect(literalOffenders("send([s, 'power'].join('_'));", names)).toEqual([]);
    expect(literalOffenders("send(['power'].concat(s));", names)).toEqual([]);
    expect(literalOffenders('send(`${kind}_other`);', new Set(['a_changed', 'b_changed']))).toEqual(
      [],
    );
    expect(literalOffenders('send(`${kind}_changed`);', new Set(['a_changed']))).toEqual([]); // one name only
    // boundaries: a suffix of exactly 6 characters counts, and a 4-character prefix (`ram_`) is too common a word
    const six = new Set(['x_abcde', 'y_abcde']);
    expect(literalOffenders('send(`${k}_abcde`);', six)).toHaveLength(1);
    const ram = new Set(['ram_a', 'ram_b']);
    expect(literalOffenders('send(`ram_${k}`);', ram)).toEqual([]);
    expect(literalOffenders("send('ram_' + k);", ram)).toEqual([]);
    const five = new Set(['abcd_x', 'abcd_y']);
    expect(literalOffenders('send(`abcd_${k}`);', five)).toHaveLength(1); // 5 characters counts
    expect(literalOffenders("send('power_' - state);", names)).toEqual([]);
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

describe('dynamicRegistryLookups (the scanner itself)', () => {
  it('flags TraceName[...] / EventName[...] with anything but a string literal key', () => {
    expect(dynamicRegistryLookups('x(TraceName[key]);')).toEqual([
      { line: 1, text: 'TraceName[key]' },
    ]);
    expect(dynamicRegistryLookups('\n\nx(EventName[a + b]);')).toEqual([
      { line: 3, text: 'EventName[a + b]' },
    ]);
  });

  it('leaves literal keys, other objects and plain property access alone', () => {
    expect(dynamicRegistryLookups("x(TraceName['BATTERY']);")).toEqual([]);
    expect(dynamicRegistryLookups('x(Other[key]);')).toEqual([]);
    expect(dynamicRegistryLookups('x(TraceName.BATTERY);')).toEqual([]);
    expect(dynamicRegistryLookups('x(a.TraceName[key]);')).toEqual([]);
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

describe('discoverSourceFiles (the scanner itself)', () => {
  it('finds every product source of every package but protocol, by directory not by content', () => {
    const root = mkdtempSync(join(tmpdir(), 'source-discovery-'));
    try {
      const put = (rel: string, text: string): void => {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
      };
      put('b/src/names-only.ts', "export const NAMES = ['battery'];"); // mentions no producer keyword
      put('a/src/deep/events.ts', 'x');
      put('a/src/launch.tsx', 'x');
      put('a/src/p.test.ts', 'x');
      put('a/src/p.test-d.ts', 'x');
      put('a/src/p.test.tsx', 'x');
      put('a/src/p.test-d.tsx', 'x');
      put('a/src/p.d.ts', 'x');
      put('a/src/notts.js', 'x');
      put('a/src/node_modules/m.ts', 'x');
      put('a/src/dist/m.ts', 'x');
      put('a/src/coverage/m.ts', 'x');
      put('a/src/.turbo/m.ts', 'x');
      put('a/test/t.ts', 'x'); // not under src
      put('protocol/src/names.ts', 'x'); // the registry's own package
      put('instrumentation-tests/src/x.ts', 'x'); // this harness
      put('loose-file.ts', 'x'); // a file, not a package
      put('nosrc/readme.md', 'x'); // a package with no src
      expect(discoverSourceFiles(root).sort()).toEqual([
        join('a', 'src', 'deep', 'events.ts'),
        join('a', 'src', 'launch.tsx'),
        join('b', 'src', 'names-only.ts'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
