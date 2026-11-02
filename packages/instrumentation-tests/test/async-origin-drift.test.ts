import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractDomPromiseMethods } from '../../../scripts/async-origin/extract.mjs';
import {
  ASYNC_ORIGIN_TABLE,
  ASYNC_ORIGIN_UNPATCHED_STATICS,
} from '../../capture/src/async-origin-table';

// Lives here, not in @bugsee/capture: it reads files, and capture is runtime-portable (no Node types).
// DRIFT GUARD (docs/design/async-origin-capture.md §5). The candidate list is generated from the installed TypeScript's
// `lib.dom.d.ts`; the table must classify every method on it, and nothing else. A new TypeScript release that adds a
// promise-returning API fails here until someone decides always / armed / off for it.
//   1. the committed snapshot equals a fresh extraction (refresh: `pnpm async-origin:refresh`);
//   2. every snapshot method is classified in the table, exactly once;
//   3. every table method is on the snapshot (no stale row);
//   4. a WebIDL mixin (no constructor of its own) names its concrete targets, and each target is a real constructor on lib.dom.d.ts;
//   5. a promise-returning STATIC method (`Notification.requestPermission`, ...) is not patched (the wrapper covers prototypes), and
//      every one is listed as such, so a new one forces a decision.
type Snapshot = ReturnType<typeof extractDomPromiseMethods>;

const snapshot = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'capture',
      'spec',
      'dom-promise-methods.snapshot.json',
    ),
    'utf8',
  ),
) as Snapshot;

const pairs = (interfaces: Snapshot['interfaces']): string[] =>
  Object.entries(interfaces)
    .flatMap(([iface, entry]) => entry.methods.map((method) => `${iface}.${method}`))
    .sort();

const pairsOfStatics = (statics: Snapshot['statics']): string[] =>
  Object.entries(statics)
    .flatMap(([iface, methods]) => methods.map((method) => `${iface}.${method}`))
    .sort();

describe('async-origin table drift', () => {
  it('the committed snapshot matches lib.dom.d.ts of the installed TypeScript', () => {
    expect(snapshot.interfaces).toEqual(extractDomPromiseMethods().interfaces);
  });

  it('classifies every promise-returning method on the snapshot, exactly once', () => {
    const classified = ASYNC_ORIGIN_TABLE.flatMap((row) =>
      row.methods.map((method) => `${row.iface}.${method}`),
    ).sort();
    expect(classified).toEqual(pairs(snapshot.interfaces));
  });

  it('gives every mixin concrete targets', () => {
    for (const row of ASYNC_ORIGIN_TABLE) {
      const entry = snapshot.interfaces[row.iface];
      expect(entry, `${row.iface} is not on the snapshot`).toBeDefined();
      if (entry?.mixin) {
        expect(
          row.targets,
          `${row.iface} is a mixin: name the constructors that carry it`,
        ).toBeDefined();
      } else {
        expect(row.targets, `${row.iface} has a constructor: no targets needed`).toBeUndefined();
      }
    }
  });

  it('every mixin target is a real constructor (or the global object itself)', () => {
    // Declared in lib.webworker, not lib.dom: absent from a window realm, where the installer skips a target the realm lacks.
    const workerOnly = ['WorkerNavigator'];
    const { constructors } = extractDomPromiseMethods();
    for (const row of ASYNC_ORIGIN_TABLE) {
      for (const target of row.targets ?? []) {
        expect(
          target === 'globalThis' || workerOnly.includes(target) || constructors.includes(target),
          `${row.iface}: target ${target} is not declared on lib.dom.d.ts`,
        ).toBe(true);
      }
    }
  });

  it('lists every promise-returning static method, and the table records each as deliberately unpatched', () => {
    expect(snapshot.statics).toEqual(extractDomPromiseMethods().statics);
    const recorded = Object.entries(ASYNC_ORIGIN_UNPATCHED_STATICS)
      .flatMap(([iface, methods]) => methods.map((method) => `${iface}.${method}`))
      .sort();
    expect(recorded).toEqual(pairsOfStatics(snapshot.statics));
  });
});
