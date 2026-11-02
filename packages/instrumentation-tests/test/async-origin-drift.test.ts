import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractDomPromiseMethods } from '../../../scripts/async-origin/extract.mjs';
import { ASYNC_ORIGIN_TABLE } from '../../capture/src/async-origin-table';

// Lives here, not in @bugsee/capture: it reads files, and capture is runtime-portable (no Node types).
// DRIFT GUARD (docs/design/async-origin-capture.md §5). The candidate list is generated from the installed TypeScript's
// `lib.dom.d.ts`; the table must classify every method on it, and nothing else. A new TypeScript release that adds a
// promise-returning API fails here until someone decides always / armed / off for it.
//   1. the committed snapshot equals a fresh extraction (refresh: `pnpm async-origin:refresh`);
//   2. every snapshot method is classified in the table, exactly once;
//   3. every table method is on the snapshot (no stale row);
//   4. a WebIDL mixin (no constructor of its own) names its concrete targets.
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
});
