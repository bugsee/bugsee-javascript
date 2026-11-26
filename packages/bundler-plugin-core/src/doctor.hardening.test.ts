// Robustness of the doctor: it must never throw, never read what it should not, never be quadratic, and must
// resolve sources the way the build did. Each test pins one reviewed failure mode.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep, win32 } from 'node:path';
import { parse } from 'acorn';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  batchEnd,
  boundedMemo,
  type DoctorReport,
  diagnoseBuildOutput,
  doctorExitCode,
  hasOriginalPosition,
  sourcePath,
  walk,
  walkDetailed,
} from './doctor';
import { isFacadeCode } from './facade';
import { READ_CEILING, readRegularFile } from './safe-read';
import { listOutputMaps } from './stamp-files';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

let root: string;
let dist: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-doctor-hard-'));
  dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }), 120_000); // removing 130k files is slow

const put = (rel: string, content: string | Buffer): string => {
  const path = join(dist, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
};
const stamp = (id: string): string =>
  `\n!function(){var g=globalThis;g._bugseeDebugIds=g._bugseeDebugIds||{};g._bugseeDebugIds["x"]="${id}"}();\n//# debugId=${id}\n`;
const mapJson = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 3,
    sources: ['a.ts'],
    sourcesContent: ['x'],
    names: [],
    mappings: 'AAAA',
    ...extra,
  });
const run = (options: Parameters<typeof diagnoseBuildOutput>[1] = {}): Promise<DoctorReport> =>
  diagnoseBuildOutput(dist, { projectRoot: root, skipEnv: true, ...options });
const ids = (report: DoctorReport): string[] => report.findings.map((f) => f.id);
const find = (report: DoctorReport, id: string) => report.findings.find((f) => f.id === id);

describe('never throws', () => {
  it('a source with a bad percent-escape is unknowable, not an exception', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put(
      'a.js.map',
      mapJson({ debugId: ID_A, sourcesContent: undefined, sources: ['file:///x/%zz.ts'] }),
    );
    const report = await run();
    expect(ids(report)).not.toContain('doctor.internal-error');
    expect(ids(report)).not.toContain('map.sources-unresolvable');
  });

  it('an unexpected internal error becomes a doctor.internal-error finding', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    const env = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    const report = await diagnoseBuildOutput(dist, { env, projectRoot: root });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      id: 'doctor.internal-error',
      severity: 'error',
    });
    expect(report.findings[0]?.message).toContain('boom');
    expect(report.summary.errors).toBe(1);
    expect(report.dir).toBe(dist);
    // a hard failure cannot be ignored away
    const ignored = await diagnoseBuildOutput(dist, {
      env,
      projectRoot: root,
      ignore: ['doctor.internal-error'],
    });
    expect(ignored.findings.map((f) => f.id)).toEqual(['doctor.internal-error']);
    expect(ignored.ignored).toBeUndefined();
  });

  it('a non-Error throw is stringified', async () => {
    const env = new Proxy(
      {},
      {
        ownKeys() {
          throw 'plain string';
        },
      },
    );
    put('a.js', 'x');
    const report = await diagnoseBuildOutput(dist, { env, projectRoot: root });
    expect(report.findings[0]?.message).toContain('plain string');
  });
});

describe('a directory with very many files', () => {
  it('the walks do not overflow the stack (130k files in one directory)', async () => {
    const big = join(dist, 'chunks');
    mkdirSync(big);
    for (let i = 0; i < 130_000; i++) {
      writeFileSync(join(big, i % 2 === 0 ? `c${i}.js` : `c${i}.map`), '');
    }
    expect((await walk(dist)).length).toBe(130_000);
    expect((await listOutputMaps(dist)).length).toBe(65_000);
  }, 120_000);

  it('20k bundles are checked in bounded time with correct counts', async () => {
    for (let i = 0; i < 20_000; i++) {
      const id = `${(i + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
      put(`assets/c${i}.js`, `${i}${stamp(id)}`);
    }
    const started = Date.now();
    const report = await run();
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(report.summary).toMatchObject({ bundles: 20_000, errors: 0, warnings: 0 });
  }, 120_000);
});

describe('reads', () => {
  const mkfifo = (path: string): boolean => spawnSync('mkfifo', [path]).status === 0;

  it('a pointer outside the output directory is reported and never read (a FIFO would hang)', async () => {
    const fifo = join(root, 'pipe.map');
    if (!mkfifo(fifo)) {
      return;
    }
    put('a.js', `a\n//# sourceMappingURL=../pipe.map${stamp(ID_A)}`);
    put('b.js', `b\n//# sourceMappingURL=../../../../../../dev/zero${stamp(ID_B)}`);
    const report = await run();
    expect(find(report, 'map.pointer-outside-dir')).toMatchObject({
      severity: 'warning',
      details: { pointers: ['a.js -> ../pipe.map', 'b.js -> ../../../../../../dev/zero'] },
    });
    expect(ids(report)).not.toContain('map.pointer-dangling');
  });

  it('a FIFO named as a map is map.unreadable, not opened; a symlink to a map inside the directory is read', async () => {
    put('a.js', `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
    if (!mkfifo(join(dist, 'a.js.map'))) {
      return;
    }
    put('real.map', mapJson({ debugId: ID_B }));
    put('b.js', `b\n//# sourceMappingURL=link.map${stamp(ID_B)}`);
    symlinkSync(join(dist, 'real.map'), join(dist, 'link.map'));
    const report = await run();
    const unreadable = report.findings.filter((f) => f.id === 'map.unreadable');
    // the FIFO is refused; the symlink to a map INSIDE the directory is simply read
    expect(unreadable.map((f) => f.file)).toEqual(['a.js.map']);
    expect(unreadable[0]?.message).toContain('not a regular file');
    expect(unreadable[0]?.severity).toBe('error');
    expect(ids(report)).not.toContain('stamp.map-id-mismatch');
  });

  it('a map larger than the limit is judged by its size, before it is read (a sparse 3 GiB file)', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    const big = put('a.js.map', '');
    truncateSync(big, 3 * 1024 ** 3);
    const report = await run();
    expect(find(report, 'map.too-large')).toMatchObject({
      severity: 'warning',
      file: 'a.js.map',
      details: { bytes: 3 * 1024 ** 3, limit: 50 * 1024 * 1024 },
    });
    expect(find(report, 'map.too-large')?.message).toContain('not read');
    expect(ids(report)).not.toContain('map.invalid');
  });

  it('map.too-large is exact at the boundary: equal is fine, one byte over is not', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    const text = mapJson({ debugId: ID_A });
    put('a.js.map', text);
    const size = Buffer.byteLength(text);
    expect(ids(await run({ maxMapBytes: size }))).not.toContain('map.too-large');
    expect(ids(await run({ maxMapBytes: size - 1 }))).toContain('map.too-large');
    // far over the limit also reports (kills a `>= limit * 2` comparison)
    expect(ids(await run({ maxMapBytes: Math.floor(size / 2) }))).toContain('map.too-large');
    expect(find(await run({ maxMapBytes: size - 1 }), 'map.too-large')?.details).toEqual({
      bytes: size,
      limit: size - 1,
    });
  });

  it('an oversized or non-regular orphan map is reported too', async () => {
    put('style.css.map', mapJson());
    put('big.css.map', 'x'.repeat(100));
    const report = await run({ maxMapBytes: 50 });
    expect(find(report, 'map.too-large')?.file).toBe('big.css.map');
  });

  it.skipIf(process.getuid?.() === 0)('a read error is a finding, not silence', async () => {
    put('a.js', `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
    const map = put('a.js.map', mapJson({ debugId: ID_A }));
    put('b.js', 'b');
    const locked = put('locked.js', 'x');
    chmodSync(map, 0o000);
    chmodSync(locked, 0o000);
    try {
      const report = await run();
      expect(find(report, 'map.unreadable')?.message).toContain('EACCES');
      expect(find(report, 'output.unreadable')).toMatchObject({
        severity: 'error',
        details: { files: ['locked.js could not be read (EACCES)'] },
      });
    } finally {
      chmodSync(map, 0o600);
      chmodSync(locked, 0o600);
    }
  });

  // the per-bundle error (its map carries an id the bundle lost), not the aggregate "not stamped" warning
  const lostStamp = (report: DoctorReport) =>
    report.findings.filter(
      (f) => f.id === 'stamp.missing-debug-id' && f.message.includes('lost its stamp'),
    );
  describe('round 23: a hidden map written to another path is paired', () => {
    it('a stamped bundle is matched by debugId and a mismatch is an error', async () => {
      put('main.js', `a${stamp(ID_A)}`);
      put('maps/main.js.map', mapJson({ file: 'main.js', debugId: ID_B }));
      const report = await run();
      expect(find(report, 'stamp.map-id-mismatch')?.file).toBe('maps/main.js.map');
      expect(report.summary.errors).toBeGreaterThan(0);
    });

    it('a stamped bundle is matched by debugId alone, whatever `file` says', async () => {
      put('main.js', `a${stamp(ID_A)}`);
      put('maps/other.map', mapJson({ file: 'zzz.js', debugId: ID_A }));
      const report = await run();
      expect(ids(report)).not.toContain('stamp.map-id-mismatch');
      expect(ids(report)).not.toContain('map.orphan');
      expect(find(report, 'stamp.map-no-debug-id')).toBeUndefined();
    });

    it('a stamped bundle whose map has no debugId is an error', async () => {
      put('main.js', `a${stamp(ID_A)}`);
      put('maps/main.js.map', mapJson({ file: 'main.js' }));
      expect(find(await run(), 'stamp.map-no-debug-id')?.file).toBe('maps/main.js.map');
    });

    it('an unstamped bundle is matched by `file`: a lost stamp is an error, not "no map on disk"', async () => {
      put('main.js', 'a');
      put('maps/main.js.map', mapJson({ file: 'main.js', debugId: ID_A }));
      const report = await run();
      expect(find(report, 'stamp.missing-debug-id')?.severity).toBe('error');
      expect(find(report, 'stamp.missing-debug-id')?.message).not.toContain('no map on disk');
    });

    it('an unstamped bundle with a `file` match but no debugId is not reported as having no map', async () => {
      put('main.js', 'a');
      put('maps/main.js.map', mapJson({ file: 'main.js' }));
      const report = await run();
      expect(report.findings.some((f) => f.message.includes('no map on disk'))).toBe(false);
    });

    it('an ambiguous `file` match pairs nothing', async () => {
      put('main.js', 'a');
      put('maps/a/main.js.map', mapJson({ file: 'main.js', debugId: ID_A }));
      put('maps/b/main.js.map', mapJson({ file: 'main.js', debugId: ID_B }));
      const report = await run();
      expect(lostStamp(report)).toHaveLength(0);
      expect(report.findings.some((f) => f.message.includes('no map on disk'))).toBe(true);
    });

    it('an ambiguous debugId match is not resolved by `file`: nothing is guessed', async () => {
      put('main.js', `a${stamp(ID_A)}`);
      put('maps/x.map', mapJson({ file: 'x.js', debugId: ID_A }));
      put('maps/y.map', mapJson({ file: 'y.js', debugId: ID_A }));
      put('maps/main.js.map', mapJson({ file: 'main.js', debugId: ID_B }));
      expect(find(await run(), 'stamp.map-id-mismatch')).toBeUndefined();
    });

    for (const [cjs, esm] of [
      ['cjs', 'esm'],
      ['esm', 'cjs'],
    ] as const) {
      it(`the pairing does not depend on walk order (${cjs} before ${esm}): a stale map is a mismatch`, async () => {
        put(`${cjs}/index.js`, `a${stamp(ID_A)}`);
        put(`maps/${cjs}/index.js.map`, mapJson({ file: 'index.js', debugId: ID_C }));
        put(`${esm}/index.js`, `b${stamp(ID_B)}`);
        put(`maps/${esm}/index.js.map`, mapJson({ file: 'index.js', debugId: ID_B }));
        const report = await run();
        expect(find(report, 'stamp.map-id-mismatch')?.file).toBe(`maps/${cjs}/index.js.map`);
      });

      it(`an unstamped copy does not take another bundle's map (${cjs} before ${esm})`, async () => {
        put(`${cjs}/index.js`, 'vendor');
        put(`${esm}/index.js`, `b${stamp(ID_B)}`);
        put(`maps/${esm}/index.js.map`, mapJson({ file: 'index.js', debugId: ID_B }));
        const report = await run();
        expect(lostStamp(report)).toHaveLength(0);
        expect(report.findings.some((f) => f.message.includes('no map on disk'))).toBe(true);
      });
    }

    it('a map that belongs to another stamped bundle is not taken by `file`', async () => {
      put('r.js', `r${stamp(ID_A)}`);
      put('maps/x.map', mapJson({ file: 'x.js', debugId: ID_A }));
      put('maps/y.map', mapJson({ file: 'y.js', debugId: ID_A }));
      put('s.js', `s${stamp(ID_B)}`);
      put('maps/s.map', mapJson({ file: 's.js', debugId: ID_A }));
      expect(find(await run(), 'stamp.map-id-mismatch')).toBeUndefined();
    });

    it('an ambiguous debugId pairs nothing (an empty map stays an orphan note)', async () => {
      put('r.js', `console.log(1)${stamp(ID_A)}`);
      const empty = JSON.stringify({
        version: 3,
        sources: [],
        names: [],
        mappings: '',
        debugId: ID_A,
      });
      put('maps/x.map', empty);
      put('maps/y.map', empty.replace('"names"', '"file":"y.js","names"'));
      const report = await run();
      expect(
        report.findings.filter((f) => f.id === 'map.no-sources' && f.severity === 'error'),
      ).toHaveLength(0);
    });

    it('costs about as much as the sibling layout: pairing is not quadratic', async () => {
      const n = 6000;
      const make = (sub: string, moved: boolean): string => {
        for (let i = 0; i < n; i++) {
          const id = `${String(i).padStart(8, '0')}-0000-4000-8000-${sub.padStart(12, '0')}`;
          put(
            `${sub}/c${i}.js`,
            `x${moved ? '' : `\n//# sourceMappingURL=c${i}.js.map`}${stamp(id)}`,
          );
          put(
            moved ? `${sub}/maps/c${i}.js.map` : `${sub}/c${i}.js.map`,
            mapJson({ file: `c${i}.js`, debugId: id }),
          );
        }
        return join(dist, sub);
      };
      const time = async (sub: string): Promise<number> => {
        const started = performance.now();
        await diagnoseBuildOutput(join(dist, sub), { projectRoot: root, skipEnv: true });
        return performance.now() - started;
      };
      make('sib', false);
      make('mov', true);
      await time('sib'); // warm up
      const sibling = await time('sib');
      const moved = await time('mov');
      // measured: ~2x (each map is read to index it and again to validate it); the old per-bundle scan was ~5x and growing
      expect(moved / sibling).toBeLessThan(3);
    }, 300000);

    it('a map is paired with one bundle only', async () => {
      put('a/main.js', 'a');
      put('b/main.js', 'b');
      put('maps/main.js.map', mapJson({ file: 'main.js', debugId: ID_A }));
      const report = await run();
      expect(lostStamp(report)).toHaveLength(1);
      expect(report.findings.some((f) => f.message.includes('no map on disk'))).toBe(true);
    });

    it('an empty hidden map of a bundle with real code is an error, not a facade note', async () => {
      put('main.js', 'console.log(1)');
      put(
        'maps/main.js.map',
        JSON.stringify({ version: 3, file: 'main.js', sources: [], names: [], mappings: '' }),
      );
      expect(find(await run(), 'map.no-sources')?.severity).toBe('error');
    });

    it('an inline-map bundle is never paired', async () => {
      put('main.js', 'a\n//# sourceMappingURL=data:application/json;base64,e30=');
      put('maps/main.js.map', mapJson({ file: 'main.js', debugId: ID_A }));
      expect(lostStamp(await run())).toHaveLength(0);
    });

    it('a remote pointer is not a hidden map: nothing is paired', async () => {
      put('main.js', 'a\n//# sourceMappingURL=https://cdn.example/main.js.map');
      put('maps/main.js.map', mapJson({ file: 'main.js', debugId: ID_A }));
      expect(lostStamp(await run())).toHaveLength(0);
    });

    it('an unreadable orphan map and an invalid one are skipped by the pairing', async () => {
      put('main.js', 'a');
      put('maps/bad.map', '{not json');
      expect(find(await run(), 'map.invalid')).toBeDefined();
    });
  });

  it('round 23: a SystemJS factory parameter or prelude variable shadows an outer helper', () => {
    const helper = 'function n(e){return e&&e.__esModule?e:{default:e}}\n';
    expect(
      isFacadeCode(
        `${helper}System.register(["dep"],function(exports){"use strict";var n=globalThis.fetch;return{setters:[function(m){exports("a",n("https://x"))}],execute:function(){}}});`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        `${helper}System.register(["dep"],function(exports,n){return{setters:[function(m){exports("a",n(m))}],execute:function(){}}});`,
      ),
    ).toBe(false);
    // unshadowed, the outer helper is still a helper
    expect(
      isFacadeCode(
        `${helper}System.register(["dep"],function(exports){return{setters:[function(m){exports("a",n(m))}],execute:function(){}}});`,
      ),
    ).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    'round 22: an empty map whose bundle could not be read is an error, not a facade note',
    async () => {
      const bundle = put('x.js', `export {}\n//# sourceMappingURL=x.js.map${stamp(ID_A)}`);
      put('x.js.map', JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
      put('other.js', 'o');
      chmodSync(bundle, 0o000);
      try {
        const report = await run();
        const finding = find(report, 'map.no-sources');
        expect(finding?.severity).toBe('error');
        expect(finding?.message).toContain('could not be read');
        expect(find(report, 'output.unreadable')?.severity).toBe('error');
      } finally {
        chmodSync(bundle, 0o600);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'round 22: a facade note is upgraded when the same map belongs to an unreadable bundle',
    async () => {
      put('a.js', `export {}\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
      const a = put(
        'a.js.map',
        JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }),
      );
      symlinkSync(a, join(dist, 'b.js.map'));
      const b = put('b.js', 'locked');
      chmodSync(b, 0o000);
      try {
        const report = await run();
        const notes = report.findings.filter((f) => f.id === 'map.no-sources');
        expect(notes.map((f) => f.severity)).toEqual(['error']);
      } finally {
        chmodSync(b, 0o600);
      }
    },
  );

  it('a script over the size limit is not read and is reported', async () => {
    put('huge.js', 'x'.repeat(1000));
    put('ok.js', `a${stamp(ID_A)}`);
    const report = await run({ maxBundleBytes: 999 });
    expect(find(report, 'output.unreadable')?.details).toEqual({
      files: ['huge.js is too large to read'],
    });
    expect(report.summary.bundles).toBe(2);
    expect(ids(await run({ maxBundleBytes: 1000 }))).not.toContain('output.unreadable');
  });

  it('a map inside the directory but outside the walked set (node_modules) is still paired by its pointer', async () => {
    put('a.js', `a\n//# sourceMappingURL=node_modules/a.map${stamp(ID_A)}`);
    put('node_modules/a.map', mapJson({ debugId: ID_B }));
    const report = await run();
    expect(find(report, 'stamp.map-id-mismatch')?.file).toBe('node_modules/a.map');
    expect(ids(report)).not.toContain('map.pointer-dangling');
  });

  it('an indented sourceMappingURL comment is honoured', async () => {
    put('a.js', `a\n   \t//# sourceMappingURL=maps/x.map${stamp(ID_A)}`);
    put('maps/x.map', mapJson({ debugId: ID_B }));
    const report = await run();
    expect(find(report, 'stamp.map-id-mismatch')?.file).toBe('maps/x.map');
  });

  it('a map that starts with a UTF-8 BOM is map.invalid and the message says BOM', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put('a.js.map', `\uFEFF${mapJson({ debugId: ID_A })}`);
    const report = await run();
    expect(find(report, 'map.invalid')?.message).toContain('BOM');
    expect(find(report, 'map.invalid')?.severity).toBe('error');
  });
});

describe('source resolution', () => {
  it('bundler-scheme sources resolve against the project root, not the map directory', async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'x.ts'), 'x');
    put('a.js', `a${stamp(ID_A)}`);
    put(
      'deep/a.js.map',
      mapJson({
        debugId: ID_A,
        sourcesContent: undefined,
        sources: ['webpack://app/./src/x.ts', 'webpack://app/./src/missing.ts'],
      }),
    );
    const report = await run();
    expect(find(report, 'map.sources-unresolvable')?.message).toContain('missing.ts');
    expect(find(report, 'map.sources-unresolvable')?.details).toEqual({ unresolved: 1, total: 2 });
  });

  it('sourcePath: posix, project root, file URLs, virtual and malformed sources', () => {
    expect(sourcePath('/m', '', 'webpack://app/./src/x.ts', '/proj', posix)).toBe('/proj/src/x.ts');
    expect(sourcePath('/m', '', 'webpack://app/./src/x.ts', undefined, posix)).toBe('/m/src/x.ts');
    expect(sourcePath('/m/d', '../s', 'a.ts', '/proj', posix)).toBe('/m/s/a.ts');
    expect(sourcePath('/m', '', '/abs/a.ts', undefined, posix)).toBe('/abs/a.ts');
    expect(sourcePath('/m', '', 'file:///x/a%20b.ts', undefined, posix)).toBe('/x/a b.ts');
    expect(sourcePath('/m', '', 'file:///x/%zz.ts', undefined, posix)).toBeUndefined();
    expect(sourcePath('/m', '', 'webpack/runtime/x', undefined, posix)).toBeUndefined();
    expect(sourcePath('/m', '', '', undefined, posix)).toBeUndefined();
  });

  it('sourcePath on Windows: drive-letter file URLs and project-relative bundler paths', () => {
    expect(sourcePath('C:\\m', '', 'file:///C:/x/a.ts', 'C:\\p', win32)).toBe('C:\\x\\a.ts');
    expect(sourcePath('C:\\m', '', 'webpack://app/./src/x.ts', 'C:\\p', win32)).toBe(
      'C:\\p\\src\\x.ts',
    );
    expect(sourcePath('C:\\m', '..\\s', 'a.ts', 'C:\\p', win32)).toBe('C:\\s\\a.ts');
    expect(sourcePath('C:\\m', '', 'D:\\abs\\a.ts', 'C:\\p', win32)).toBe('D:\\abs\\a.ts');
  });
});

describe('pointer reading and pairing (round 2)', () => {
  it('a pointer with an unencoded space is read whole (the stamper reads to the end of the line)', async () => {
    put('a.js', `a\n//# sourceMappingURL=maps/my map.map${stamp(ID_A)}`);
    put('maps/my map.map', mapJson({ debugId: ID_B }));
    const report = await run();
    expect(find(report, 'stamp.map-id-mismatch')?.file).toBe('maps/my map.map');
  });

  it('the LAST sourceMappingURL comment wins', async () => {
    put('a.js', `a\n//# sourceMappingURL=gone.map\n//# sourceMappingURL=real.map${stamp(ID_A)}`);
    put('real.map', mapJson({ debugId: ID_B }));
    const report = await run();
    expect(find(report, 'stamp.map-id-mismatch')?.file).toBe('real.map');
    expect(ids(report)).not.toContain('map.pointer-dangling');
  });

  it('uppercase extensions are scripts and maps too, like the stamper', async () => {
    put('A.JS', `a${stamp(ID_A)}`);
    put('A.JS.map', mapJson({ debugId: ID_B }));
    put('C.MAP', mapJson());
    const report = await run();
    expect(report.summary).toMatchObject({ bundles: 1, maps: 2 });
    expect(find(report, 'stamp.map-id-mismatch')?.file).toBe('A.JS.map');
  });

  it('a map shared by two bundles is validated once', async () => {
    put('a.js', `a\n//# sourceMappingURL=shared.map${stamp(ID_A)}`);
    put('b.js', `b\n//# sourceMappingURL=shared.map${stamp(ID_A)}`);
    put('shared.map', mapJson({ debugId: ID_A, sources: [] }));
    const report = await run();
    expect(report.findings.filter((f) => f.id === 'map.no-sources')).toHaveLength(1);
  });

  it('isInside: the parent itself is outside, a `..`-prefixed NAME inside the directory is not', async () => {
    put('a.js', `a\n//# sourceMappingURL=..${stamp(ID_A)}`);
    put('..b/x.map', mapJson({ debugId: ID_B }));
    put('b.js', `b\n//# sourceMappingURL=..b/x.map${stamp(ID_B)}`);
    const report = await run();
    expect(find(report, 'map.pointer-outside-dir')?.details).toEqual({ pointers: ['a.js -> ..'] });
    expect(ids(report)).not.toContain('map.unreadable');
    expect(ids(report)).not.toContain('map.pointer-dangling');
  });

  it('virtual sources never name a file; look-alikes do', () => {
    for (const virtual of [
      'webpack/runtime/x',
      '(webpack)/buildin/x.js',
      '\0virtual',
      'a\0b.ts',
      '<anonymous>',
      'rollup:plugin/x',
      'vite/preload-helper.js',
    ]) {
      expect(sourcePath('/m', '', virtual, undefined, posix), virtual).toBeUndefined();
    }
    for (const real of ['webpackx/a.ts', 'viteish/a.ts', 'rollupx.ts', 'webpack.config.js']) {
      expect(sourcePath('/m', '', real, undefined, posix), real).toBe(`/m/${real}`);
    }
  });
});

describe.skipIf(process.getuid?.() === 0)('an unreadable output directory', () => {
  it('reports output.no-js and does not throw', async () => {
    put('a.js', 'x');
    chmodSync(dist, 0o000);
    try {
      const report = await run();
      expect(ids(report)).toContain('output.no-js');
      expect(ids(report)).not.toContain('doctor.internal-error');
      expect(find(report, 'output.dir-unreadable')?.details).toEqual({ directories: ['.'] });
    } finally {
      chmodSync(dist, 0o700);
    }
  });

  it('an unreadable SUB-directory is an error naming it, never a silent pass', async () => {
    put('registerSW.js', `a${stamp(ID_A)}`);
    put('assets/index.js', 'unstamped');
    put('assets/deeper/x.js', 'x');
    chmodSync(join(dist, 'assets'), 0o000);
    try {
      const report = await run();
      expect(find(report, 'output.dir-unreadable')).toMatchObject({
        severity: 'error',
        details: { directories: ['assets'] },
      });
      expect(report.passed).not.toContain('output.dir-unreadable');
      expect(doctorExitCode(report, false)).toBe(2);
    } finally {
      chmodSync(join(dist, 'assets'), 0o700);
    }
    expect(ids(await run())).not.toContain('output.dir-unreadable');
  });

  it('--exclude can name an unreadable directory: it leaves output.dir-unreadable, is listed as excluded, and its pattern is matched', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put('vendor/x.js', 'x');
    put('assets/y.js', 'y');
    chmodSync(join(dist, 'vendor'), 0o000);
    chmodSync(join(dist, 'assets'), 0o000);
    try {
      for (const pattern of ['vendor/**', 'vendor/', '**/vendor/**', '**']) {
        const report = await run({ exclude: [pattern] });
        const left = find(report, 'output.dir-unreadable')?.details?.directories;
        expect(left, pattern).toEqual(pattern === '**' ? undefined : ['assets']);
        expect(ids(report), pattern).not.toContain('output.exclude-unmatched');
      }
      const report = await run({ exclude: ['vendor/**'] });
      expect(
        report.findings.some(
          (f) =>
            f.id === 'output.excluded' &&
            (f.details?.directories as string[] | undefined)?.includes('vendor'),
        ),
      ).toBe(true);
      // a glob that would NOT hide the directory's files if it could be listed must not hide the directory either
      for (const pattern of [
        'vendor',
        'vendor*',
        'vendor/*',
        '*',
        'assets/*',
        'vendor/**/*.js',
        '**/*.js',
        '**/a/**',
        'vendor/**/*.map',
      ]) {
        const kept = find(await run({ exclude: [pattern] }), 'output.dir-unreadable')?.details;
        expect(kept, pattern).toEqual({ directories: ['assets', 'vendor'] });
      }
      expect(find(await run({ exclude: ['nope/**'] }), 'output.dir-unreadable')?.details).toEqual({
        directories: ['assets', 'vendor'],
      });
    } finally {
      chmodSync(join(dist, 'vendor'), 0o700);
      chmodSync(join(dist, 'assets'), 0o700);
    }
  });

  it('several unreadable directories are listed, sorted', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    for (let i = 2; i >= 0; i--) {
      put(`d${i}/p.js`, 'x');
      chmodSync(join(dist, `d${i}`), 0o000);
    }
    try {
      const finding = find(await run(), 'output.dir-unreadable');
      expect(finding?.details).toEqual({ directories: ['d0', 'd1', 'd2'] });
    } finally {
      for (let i = 0; i < 3; i++) {
        chmodSync(join(dist, `d${i}`), 0o700);
      }
    }
  });

  it('a directory only the HTML page walk enters (src/, which the fenced script walk skips) is reported too', async () => {
    put('package.json', '{"name":"p"}');
    put('a.js', `a${stamp(ID_A)}`);
    put('src/p.html', '<p>');
    chmodSync(join(dist, 'src'), 0o000);
    const here = process.cwd();
    process.chdir(dist);
    try {
      const finding = find(await run(), 'output.dir-unreadable');
      expect(finding?.details).toEqual({ directories: ['src'] });
    } finally {
      process.chdir(here);
      chmodSync(join(dist, 'src'), 0o700);
    }
  });
});

describe('CRLF bundles (a Windows toolchain)', () => {
  it('an inline map after a CRLF line is still map.inline, and a pointer with CR is paired', async () => {
    put('a.js', `a\r\n//# sourceMappingURL=data:application/json;base64,e30=\r\n${stamp(ID_A)}`);
    put('b.js', `b\r\n//# sourceMappingURL=maps/b.map\r\n${stamp(ID_B)}`);
    put('maps/b.map', mapJson({ debugId: ID_A }));
    const report = await run();
    expect(find(report, 'map.inline')?.details).toEqual({ files: ['a.js'] });
    expect(find(report, 'stamp.map-id-mismatch')?.file).toBe('maps/b.map');
    expect(ids(report)).not.toContain('map.hidden');
  });
});

describe('symlinks never lead outside the output directory (round 3)', () => {
  const secretMap = (): string =>
    JSON.stringify({
      version: 3,
      debugId: ID_B,
      sources: ['TOP-SECRET-SOURCE-PATH.ts'],
      sourcesContent: ['TOP-SECRET-CONTENT'],
      mappings: 'AAAA',
    });

  it('a pointer through a symlinked DIRECTORY is not read: no outside content in any output', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.json'), secretMap());
    symlinkSync(outside, join(dist, 'link'));
    put('app.js', `a\n//# sourceMappingURL=link/secret.json${stamp(ID_A)}`);
    const report = await run();
    expect(find(report, 'map.pointer-outside-dir')?.details).toEqual({
      pointers: ['app.js -> link/secret.json'],
    });
    const everything = JSON.stringify(report);
    expect(everything).not.toContain('TOP-SECRET');
    expect(everything).not.toContain(ID_B);
    expect(ids(report)).not.toContain('stamp.map-id-mismatch');
    expect(ids(report)).not.toContain('map.sources-unresolvable');
  });

  it('a pointer through a symlinked directory that stays INSIDE the directory is read normally', async () => {
    put('real/x.map', mapJson({ debugId: ID_B }));
    symlinkSync(join(dist, 'real'), join(dist, 'alias'));
    put('app.js', `a\n//# sourceMappingURL=alias/x.map${stamp(ID_A)}`);
    const report = await run();
    expect(find(report, 'stamp.map-id-mismatch')).toBeDefined();
  });

  it('a symlinked directory that leaves the output directory is never descended into by the walk', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'o.js'), 'x');
    symlinkSync(outside, join(dist, 'linkdir'));
    put('a.js', `a${stamp(ID_A)}`);
    expect(relFiles(await walk(dist))).toEqual(['a.js']);
  });

  it('a symlinked bundle that leads OUTSIDE is reported, not silently invisible (no misleading output.no-js)', async () => {
    const real = join(root, 'real.js');
    writeFileSync(real, `a${stamp(ID_A)}`);
    symlinkSync(real, join(dist, 'app.js'));
    const report = await run();
    // not the misleading "No .js files found": the script IS there, and nothing could be read
    expect(find(report, 'output.no-js')?.message).toContain('could be read');
    expect(find(report, 'output.unreadable')?.details).toEqual({
      files: ['app.js resolves outside the output directory'],
    });
    expect(report.summary.bundles).toBe(1);
  });

  it('a manifest that is a symlink to a file outside is not read', async () => {
    const outside = join(root, 'outside-manifest.json');
    writeFileSync(outside, '{"integrity":"x"}');
    symlinkSync(outside, join(dist, 'asset-manifest.json'));
    put('a.js', `a${stamp(ID_A)}`);
    expect(ids(await run())).not.toContain('sri.manifest-hashes');
  });

  it('an uppercase MANIFEST.JSON is still a manifest', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put('ASSET-MANIFEST.JSON', '{"integrity":"x"}');
    expect(ids(await run())).toContain('sri.manifest-hashes');
  });
});

describe('--ignore cannot hide a hard failure (round 3)', () => {
  it('output.dir-missing, output.no-js and doctor.internal-error stay in the report', async () => {
    const missing = await diagnoseBuildOutput(join(root, 'nope'), {
      ignore: ['output.dir-missing'],
      skipEnv: true,
    });
    expect(ids(missing)).toEqual(['output.dir-missing']);
    expect(missing.summary.errors).toBe(1);
    expect(missing.ignored).toBeUndefined();
    const empty = await run({ ignore: ['output.no-js', 'map.public-leftover'] });
    expect(ids(empty)).toEqual(['output.no-js']);
    expect(empty.ignored).toBeUndefined();
  });
});

describe('SRI reads are as guarded as every other read (review thread)', () => {
  const sri = (bytes: string | Buffer): string =>
    `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
  const page = (src: string, integrity: string): string =>
    `<script src="${src}" integrity="${integrity}"></script>`;

  it('a pinned script that is a FIFO never hangs the doctor', async () => {
    if (spawnSync('mkfifo', [join(dist, 'app.js')]).status !== 0) {
      return;
    }
    put('index.html', page('app.js', sri('x')));
    const report = await run();
    // a FIFO named like a script is listed and refused (never opened), and the pin does not open it either
    expect(find(report, 'output.unreadable')?.details).toEqual({
      files: ['app.js is not a regular file'],
    });
    expect(find(report, 'output.no-js')?.message).toContain('could be read');
    expect(ids(report)).not.toContain('sri.mismatch');
    expect(ids(report)).not.toContain('sri.unstamped-hazard');
    expect(find(report, 'sri.pin-unreadable')?.details).toEqual({
      scripts: ['app.js is not a regular file'],
    });
  }, 10_000);

  it('a pinned symlink to /dev/zero is refused, never read', async () => {
    symlinkSync('/dev/zero', join(dist, 'zero.js'));
    put('index.html', page('zero.js', sri('x')));
    const report = await run();
    expect(find(report, 'output.unreadable')?.details).toEqual({
      files: ['zero.js resolves outside the output directory'],
    });
    expect(find(report, 'sri.pin-unreadable')?.details).toEqual({
      scripts: ['zero.js resolves outside the output directory'],
    });
    expect(ids(report)).not.toContain('sri.mismatch');
  }, 10_000);

  it('a pinned script reached through a symlinked directory is not read or hashed', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'app.js'), `x${stamp(ID_A)}`);
    symlinkSync(outside, join(dist, 'vendor'));
    put('index.html', page('vendor/app.js', sri('something else')));
    const report = await run();
    expect(ids(report)).not.toContain('sri.mismatch');
    expect(ids(report)).not.toContain('sri.unstamped-hazard');
  });

  it('a pinned regular script whose bytes no longer match is still sri.mismatch (read once)', async () => {
    put('app.js', `c${stamp(ID_A)}`);
    put('index.html', page('app.js', sri('c')));
    const report = await run();
    expect(find(report, 'sri.mismatch')?.details).toEqual({ scripts: ['app.js'] });
  });
});

describe('symlinks that stay inside the directory (round 4)', () => {
  it('a pnpm-style symlinked bundle and map are read through their real path: no error, no double report', async () => {
    put('.store/app.js', `c\n//# sourceMappingURL=app.js.map${stamp(ID_A)}`);
    put('.store/app.js.map', mapJson({ debugId: ID_A }));
    mkdirSync(join(dist, 'assets'));
    symlinkSync(join(dist, '.store', 'app.js'), join(dist, 'assets', 'app.js'));
    symlinkSync(join(dist, '.store', 'app.js.map'), join(dist, 'assets', 'app.js.map'));
    const report = await run();
    expect(report.summary.errors).toBe(0);
    expect(ids(report)).not.toContain('output.unreadable');
    expect(ids(report)).not.toContain('map.unreadable');
    expect(ids(report)).not.toContain('stamp.duplicate-debug-id');
  });

  it('a symlink to a file inside whose map id differs is judged like the real file', async () => {
    put('.store/app.js', `c${stamp(ID_A)}`);
    put('.store/app.js.map', mapJson({ debugId: ID_B }));
    symlinkSync(join(dist, '.store', 'app.js'), join(dist, 'app.js'));
    symlinkSync(join(dist, '.store', 'app.js.map'), join(dist, 'app.js.map'));
    const report = await run();
    expect(ids(report)).toContain('stamp.map-id-mismatch');
  });

  it('a dangling or looping symlink is still reported, never read', async () => {
    symlinkSync(join(dist, 'nowhere.js'), join(dist, 'dangling.js'));
    symlinkSync(join(dist, 'loop-b.js'), join(dist, 'loop-a.js'));
    symlinkSync(join(dist, 'loop-a.js'), join(dist, 'loop-b.js'));
    put('ok.js', `a${stamp(ID_A)}`);
    const report = await run();
    const files = (find(report, 'output.unreadable')?.details?.files as string[]).sort();
    expect(files).toEqual([
      'dangling.js could not be resolved (ENOENT)',
      'loop-a.js could not be resolved (ELOOP)',
      'loop-b.js could not be resolved (ELOOP)',
    ]);
  });

  it('a pinned script that is a symlink INSIDE the directory is read: a mismatch is not silently skipped', async () => {
    put('.store/app.js', `c${stamp(ID_A)}`);
    symlinkSync(join(dist, '.store', 'app.js'), join(dist, 'app.js'));
    put('index.html', `<script src="app.js" integrity="sha384-AAAA"></script>`);
    const report = await run();
    expect(find(report, 'sri.mismatch')?.details).toEqual({ scripts: ['app.js'] });
    expect(ids(report)).not.toContain('sri.pin-unreadable');
  });

  it('a map reached through two names is validated once', async () => {
    put('real/x.map', 'not json');
    symlinkSync(join(dist, 'real'), join(dist, 'alias'));
    put('a.js', `a\n//# sourceMappingURL=real/x.map${stamp(ID_A)}`);
    put('b.js', `b\n//# sourceMappingURL=alias/x.map${stamp(ID_B)}`);
    const report = await run();
    expect(report.findings.filter((f) => f.id === 'map.invalid')).toHaveLength(1);
  });
});

describe('big outputs stay readable (round 4)', () => {
  it('sources-content notes: a few are listed, many become ONE finding with counts', async () => {
    for (let i = 0; i < 3; i++) {
      put(`s${i}.js`, `a${stamp(`0000000${i}-1111-4111-8111-111111111111`)}`);
      put(`s${i}.js.map`, mapJson({ debugId: `0000000${i}-1111-4111-8111-111111111111` }));
    }
    const few = await run();
    expect(few.findings.filter((f) => f.id === 'map.sources-content')).toHaveLength(3);
    // 10 notes (2 x the listing cap) are still listed one by one; the 11th folds them into one finding.
    for (let i = 3; i < 10; i++) {
      const id = `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
      put(`s${i}.js`, `a${stamp(id)}`);
      put(`s${i}.js.map`, mapJson({ debugId: id }));
    }
    const ten = await run();
    expect(ten.findings.filter((f) => f.id === 'map.sources-content')).toHaveLength(10);
    for (let i = 10; i < 11; i++) {
      const id = `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
      put(`s${i}.js`, `a${stamp(id)}`);
      put(`s${i}.js.map`, mapJson({ debugId: id }));
    }
    expect((await run()).findings.filter((f) => f.id === 'map.sources-content')).toHaveLength(1);
    for (let i = 11; i < 14; i++) {
      const id = `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
      put(`s${i}.js`, `a${stamp(id)}`);
      put(`s${i}.js.map`, mapJson({ debugId: id }));
    }
    const many = await run();
    const notes = many.findings.filter((f) => f.id === 'map.sources-content');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.details).toEqual({ maps: 14, embedded: 14, resolvableOnDisk: 0 });
    expect(notes[0]?.file).toBeUndefined();
  });

  it('a list of exactly 100 is not capped and carries no total', async () => {
    for (let i = 0; i < 100; i++) {
      put(`e${i}.js`, `x${i}`);
    }
    const finding = find(await run(), 'stamp.missing-debug-id');
    expect((finding?.details?.files as string[]).length).toBe(100);
    expect(finding?.details).not.toHaveProperty('total');
  });

  it('long file lists in details are capped, with the total', async () => {
    for (let i = 0; i < 130; i++) {
      put(`v${i}.js`, `x${i}`);
    }
    const report = await run();
    const finding = find(report, 'stamp.missing-debug-id');
    expect((finding?.details?.files as string[]).length).toBe(100);
    expect(finding?.details?.total).toBe(130);
    put('w.js', 'x');
    const exact = await run();
    expect(find(exact, 'stamp.missing-debug-id')?.details?.total).toBe(131);
  });

  it('an oversized page is reported as sri.html-skipped, and the rest of the audit goes on', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    const big = put('huge.html', '');
    truncateSync(big, 8 * 1024 * 1024 + 1);
    const report = await run();
    expect(find(report, 'sri.html-skipped')).toMatchObject({
      severity: 'warning',
      details: { files: ['huge.html'] },
    });
    expect(report.summary.bundles).toBe(1);
  });

  it('--exclude applies to HTML pages too: an oversized or unreadable excluded page is not reported, and its pattern is matched', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    truncateSync(put('huge.html', ''), 8 * 1024 * 1024 + 1);
    truncateSync(put('keep/huge2.html', ''), 8 * 1024 * 1024 + 1);
    const report = await run({ exclude: ['huge.html'] });
    expect(find(report, 'sri.html-skipped')?.details).toEqual({ files: ['keep/huge2.html'] });
    expect(ids(report)).not.toContain('output.exclude-unmatched');
    expect(ids(await run({ exclude: ['**/*.html'] }))).not.toContain('sri.html-skipped');
  });

  it.skipIf(process.getuid?.() === 0)(
    'an unreadable excluded page is not reported either',
    async () => {
      put('a.js', `a${stamp(ID_A)}`);
      const page = put('locked.html', '<p>');
      chmodSync(page, 0o000);
      try {
        expect(ids(await run())).toContain('sri.html-skipped');
        const report = await run({ exclude: ['locked.html'] });
        expect(ids(report)).not.toContain('sri.html-skipped');
        expect(ids(report)).not.toContain('output.exclude-unmatched');
      } finally {
        chmodSync(page, 0o600);
      }
    },
  );

  it('a page of pathological unterminated tags does not stall the doctor', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put('index.html', '<script '.repeat(400_000 / 8));
    const started = Date.now();
    const report = await run();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ids(report)).not.toContain('doctor.internal-error');
  });
});

describe('files the build did not emit (round 6)', () => {
  const healthy = () => {
    put('app.js', `a${stamp(ID_A)}`);
    put('app.js.map', mapJson({ debugId: ID_A }));
  };

  it('a copied public/ script (with and without a map) is an error until --exclude drops it', async () => {
    healthy();
    put('public/pdf.worker.min.mjs', 'w');
    put('public/pdf.worker.min.mjs.map', mapJson());
    put('public/sw.js', 's');
    const before = await run();
    expect(ids(before)).toContain('stamp.missing-debug-id');
    expect(ids(before)).toContain('stamp.mixed');
    const after = await run({ exclude: ['public/**'] });
    expect(ids(after)).not.toContain('stamp.missing-debug-id');
    expect(ids(after)).not.toContain('stamp.mixed');
    expect(after.summary).toMatchObject({ errors: 0, warnings: 0, bundles: 1, maps: 1 });
    expect(find(after, 'output.excluded')).toMatchObject({
      severity: 'info',
      details: {
        files: ['public/pdf.worker.min.mjs', 'public/pdf.worker.min.mjs.map', 'public/sw.js'],
      },
    });
  });

  it('an exclude that matches nothing is SAID (a silent miss looks like a bug in the doctor), as an info', async () => {
    healthy();
    const report = await run({ exclude: ['nope/**', 'app.js'] });
    expect(ids(report)).toContain('output.excluded'); // app.js matched
    expect(find(report, 'output.exclude-unmatched')).toMatchObject({
      severity: 'info',
      details: { patterns: ['nope/**'] },
    });
    expect(ids(await run({ exclude: ['app.js'] }))).not.toContain('output.exclude-unmatched');
  });

  it('Vite copies publicDir to the ROOT of the output: root-level patterns and a leading ./ both work', async () => {
    healthy();
    put('mockServiceWorker.js', 'w');
    put('pdf.worker.min.mjs', 'w');
    put('pdf.worker.min.mjs.map', mapJson());
    const report = await run({ exclude: ['./mockServiceWorker.js', 'pdf.worker.min.mjs*'] });
    expect(report.summary).toMatchObject({ errors: 0, warnings: 0, bundles: 1, maps: 1 });
    expect(find(report, 'output.excluded')?.details).toEqual({
      files: ['mockServiceWorker.js', 'pdf.worker.min.mjs', 'pdf.worker.min.mjs.map'],
    });
    expect(ids(report)).not.toContain('output.exclude-unmatched');
  });

  it('an excluded script pinned by a page is not judged for SRI either', async () => {
    healthy();
    put('vendor.js', 'v');
    put('index.html', `<script src="vendor.js" integrity="sha384-AAAA"></script>`);
    const before = await run();
    expect(ids(before)).toContain('sri.mismatch');
    const after = await run({ exclude: ['vendor.js'] });
    expect(ids(after)).not.toContain('sri.mismatch');
    expect(ids(after)).not.toContain('sri.unstamped-hazard');
  });

  it('a pointer to an excluded map is neither read nor reported', async () => {
    put('a.js', `a\n//# sourceMappingURL=maps/a.js.map${stamp(ID_A)}`);
    put('maps/a.js.map', mapJson({ debugId: ID_B }));
    expect(ids(await run())).toContain('stamp.map-id-mismatch');
    const report = await run({ exclude: ['maps/**'] });
    expect(ids(report)).not.toContain('stamp.map-id-mismatch');
    expect(ids(report)).not.toContain('map.pointer-dangling');
    expect(find(report, 'output.excluded')?.details).toEqual({ files: ['maps/a.js.map'] });
  });

  it('a pattern that matches only an SRI pin outside the walked files still counts as matched', async () => {
    put('package.json', '{"name":"p"}');
    put('app.js', `a${stamp(ID_A)}`);
    put('tests/vendor.js', 'v'); // in a fenced (skipped) directory: not in the walk
    put('index.html', `<script src="tests/vendor.js" integrity="sha384-AAAA"></script>`);
    const here = process.cwd();
    process.chdir(dist);
    try {
      const report = await run({ exclude: ['tests/vendor.js'] });
      expect(ids(report)).not.toContain('output.exclude-unmatched');
      expect(ids(report)).not.toContain('sri.mismatch');
    } finally {
      process.chdir(here);
    }
  });

  it('the new info-only IDs are facts, never "passed"', async () => {
    healthy();
    put('public/x.js', 'x');
    const report = await run({ exclude: ['public/**'] });
    expect(report.passed).not.toContain('output.excluded');
    expect(report.passed).not.toContain('output.exclude-unmatched');
    expect(report.passed).not.toContain('output.walk-fenced');
  });

  it('glob semantics: * stays in a directory, ** crosses them, ? is one character, a trailing / is a directory', async () => {
    healthy();
    put('a1.js', 'x');
    put('sub/a2.js', 'x');
    put('sub/deep/a3.js', 'x');
    put('vendor/v.js', 'x');
    put('vendor/xv.js', 'x');
    const excluded = async (pattern: string): Promise<string[]> =>
      (find(await run({ exclude: [pattern] }), 'output.excluded')?.details?.files as string[]) ??
      [];
    expect(await excluded('a?.js')).toEqual(['a1.js']);
    expect(await excluded('*.js')).toEqual(['a1.js', 'app.js']);
    expect(await excluded('**/*.js')).toEqual([
      'a1.js',
      'app.js',
      'sub/a2.js',
      'sub/deep/a3.js',
      'vendor/v.js',
      'vendor/xv.js',
    ]);
    expect(await excluded('sub/*.js')).toEqual(['sub/a2.js']);
    expect(await excluded('sub/**')).toEqual(['sub/a2.js', 'sub/deep/a3.js']);
    expect(await excluded('vendor/')).toEqual(['vendor/v.js', 'vendor/xv.js']);
    expect(await excluded('a.js')).toEqual([]); // `.` is a literal dot, not "any character"
    expect(await excluded('a1+js')).toEqual([]);
    expect(await excluded('[a]1.js')).toEqual([]); // regex syntax in a glob is literal
    expect(await excluded('sub?a2.js')).toEqual([]); // `?` is never a slash
    expect(await excluded('**/v.js')).toEqual(['vendor/v.js']); // `**/` is whole path segments: xv.js is not v.js
    expect(await excluded('**/a2.js')).toEqual(['sub/a2.js']);
    expect(await excluded('**/p.js')).toEqual([]);
  });

  it('excluding every script leaves output.no-js, which cannot be hidden', async () => {
    put('public/sw.js', 's');
    const report = await run({ exclude: ['**'] });
    expect(ids(report)).toContain('output.no-js');
  });

  it('a long exclusion list is capped, with the total', async () => {
    healthy();
    for (let i = 0; i < 120; i++) {
      put(`public/f${i}.js`, 'x');
    }
    const finding = find(await run({ exclude: ['public/**'] }), 'output.excluded');
    expect((finding?.details?.files as string[]).length).toBe(100);
    expect(finding?.details?.total).toBe(120);
  });
});

describe('the walk fence is reported, and needs a real project directory (round 6)', () => {
  const inDist = async (options: Parameters<typeof run>[0] = {}): Promise<DoctorReport> => {
    const here = process.cwd();
    process.chdir(dist);
    try {
      return await run(options);
    } finally {
      process.chdir(here);
    }
  };

  it('run from inside an output directory WITHOUT a package.json, src/ and dot-directories are audited', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put('src/s.js', 'x');
    put('.cache/c.js', 'x');
    put('a/b/c/d/e/f/g/h/deep.js', 'x');
    const report = await inDist();
    expect(report.summary.bundles).toBe(4);
    expect(ids(report)).not.toContain('output.walk-fenced');
  });

  it('a directory that is the project (has a package.json) is fenced, and the report lists what was skipped', async () => {
    put('package.json', '{"name":"p"}');
    put('a.js', `a${stamp(ID_A)}`);
    put('src/s.js', 'x');
    put('.cache/c.js', 'x');
    put('tests/t.js', 'x');
    put('a/b/c/d/e/f/g/h/deep.js', 'x');
    const report = await inDist();
    expect(report.summary.bundles).toBe(1);
    expect(find(report, 'output.walk-fenced')).toMatchObject({
      severity: 'info',
      details: { directories: ['.cache', 'a/b/c/d/e/f/g', 'src', 'tests'] },
    });
  });

  it('a project directory that is not the working directory is not fenced', async () => {
    put('package.json', '{"name":"p"}');
    put('src/s.js', 'x');
    put('a.js', `a${stamp(ID_A)}`);
    expect((await run()).summary.bundles).toBe(2);
  });
});

describe('round 7 review findings', () => {
  const mkfifo = (path: string): boolean => spawnSync('mkfifo', [path]).status === 0;
  const sri = (bytes: string): string =>
    `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

  it('when EVERY script is unreadable the audit cannot pass, even with --ignore output.unreadable', async () => {
    if (!mkfifo(join(dist, 'a.js'))) {
      return;
    }
    const report = await run({ ignore: ['output.unreadable'] });
    expect(find(report, 'output.no-js')).toMatchObject({ severity: 'error' });
    expect(find(report, 'output.no-js')?.message).toContain('could be read');
  });

  it('some unreadable scripts are an ordinary, ignorable finding', async () => {
    put('ok.js', `a${stamp(ID_A)}`);
    if (!mkfifo(join(dist, 'a.js'))) {
      return;
    }
    const report = await run({ ignore: ['output.unreadable'] });
    expect(ids(report)).not.toContain('output.no-js');
  });

  it('a version-3 map without mappings (or sections) is map.invalid', async () => {
    put('a.js', `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
    put(
      'a.js.map',
      JSON.stringify({ version: 3, sources: ['a.ts'], sourcesContent: ['x'], debugId: ID_A }),
    );
    const report = await run();
    expect(find(report, 'map.invalid')?.message).toContain('mappings');
    const sectioned = {
      debugId: ID_A,
      mappings: undefined,
      sources: undefined,
      sourcesContent: undefined,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: {
            version: 3,
            sources: ['a.ts'],
            sourcesContent: ['x'],
            names: [],
            mappings: 'AAAA',
          },
        },
      ],
    };
    put('a.js.map', mapJson(sectioned));
    expect(ids(await run())).not.toContain('map.invalid');
    put('a.js.map', mapJson({ debugId: ID_A, mappings: 5 }));
    expect(ids(await run())).toContain('map.invalid');
  });

  it('an unreadable HTML page is reported as not scanned, never silently passed', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    const page = put('index.html', `<script src="a.js" integrity="${sri('x')}"></script>`);
    chmodSync(page, 0o000);
    try {
      if (spawnSync('sh', ['-c', `cat '${page}' >/dev/null 2>&1`]).status === 0) {
        return; // running as root: the permission does not bite
      }
      const finding = find(await run(), 'sri.html-skipped');
      expect(finding).toMatchObject({ severity: 'warning', details: { files: ['index.html'] } });
      expect(finding?.message).toContain('could not be read');
    } finally {
      chmodSync(page, 0o600);
    }
  });

  it('the same script pinned by two pages with different hashes: the stale pin is reported', async () => {
    const js = `console.log(1);${stamp(ID_A)}`;
    put('a.js', js);
    put('a.html', `<script src="a.js" integrity="${sri(js)}"></script>`);
    put('b.html', `<script src="a.js" integrity="${sri('older bytes')}"></script>`);
    const report = await run();
    expect(find(report, 'sri.mismatch')).toMatchObject({ details: { scripts: ['a.js'] } });
  });

  it('passed lists only checks that had input: nothing for the stamp/map checks of an empty directory', async () => {
    const report = await run();
    expect(ids(report)).toContain('output.no-js');
    for (const id of [
      'stamp.missing-registration',
      'stamp.map-id-mismatch',
      'map.invalid',
      'build.dev-bundle',
    ]) {
      expect(report.passed).not.toContain(id);
    }
    put('a.js', `a${stamp(ID_A)}`);
    const healthy = await run();
    expect(healthy.passed).toContain('stamp.missing-registration');
    expect(healthy.passed).not.toContain('map.invalid'); // a bundle but no map: nothing to validate
    put('a.js.map', mapJson({ debugId: ID_A }));
    expect((await run()).passed).toContain('map.invalid');
  });
});

describe('batchEnd bounds the bytes read at once', () => {
  it('stops at the count limit, at the byte budget, and always takes at least one', () => {
    expect(batchEnd([1, 1, 1, 1], 0, 2, 100)).toBe(2);
    expect(batchEnd([10, 10, 10, 10], 0, 16, 25)).toBe(2);
    expect(batchEnd([10, 10, 10, 10], 0, 16, 20)).toBe(2);
    expect(batchEnd([10, 10, 10, 10], 0, 16, 40)).toBe(4);
    expect(batchEnd([500, 1, 1], 0, 16, 100)).toBe(1);
    expect(batchEnd([1, 500, 1], 1, 16, 100)).toBe(2);
    expect(batchEnd([1, 1], 1, 16, 100)).toBe(2);
  });
});

describe('the SRI page walk follows the doctor fence (round 8)', () => {
  const sri = (bytes: string): string =>
    `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
  const pin = (): void => {
    put('app.js', `console.log(1);${stamp(ID_A)}`);
  };

  it('an output directory is scanned for pages in test/, dot-directories and deep paths too', async () => {
    pin();
    put(
      'tests/index.html',
      '<script src="../app.js" integrity="' + sri('older bytes') + '"></script>',
    );
    expect(ids(await run())).toContain('sri.mismatch');
    rmSync(join(dist, 'tests'), { recursive: true });
    put('.well/p.html', '<script src="../app.js" integrity="' + sri('older bytes') + '"></script>');
    expect(ids(await run())).toContain('sri.mismatch');
    rmSync(join(dist, '.well'), { recursive: true });
    put(
      'a/b/c/d/e/f/g/h/p.html',
      '<script src="../../../../../../../../app.js" integrity="' +
        sri('older bytes') +
        '"></script>',
    );
    expect(ids(await run())).toContain('sri.mismatch');
  });

  it('a fenced project directory keeps the fence for pages too, and the walk-fenced finding says what was skipped', async () => {
    put('package.json', '{"name":"p"}');
    pin();
    put(
      'tests/index.html',
      '<script src="../app.js" integrity="' + sri('older bytes') + '"></script>',
    );
    const here = process.cwd();
    process.chdir(dist);
    try {
      const report = await run();
      expect(ids(report)).not.toContain('sri.mismatch');
      expect(find(report, 'output.walk-fenced')?.details).toEqual({ directories: ['tests'] });
    } finally {
      process.chdir(here);
    }
  });
});

describe('a pointer with a ?query (webpack / Rspack [name].js?[contenthash]) (round 9)', () => {
  it('pairs the map the query-less path names, and does not call the pointer dangling', async () => {
    // NOT a sibling: only following the pointer (query cut) can find it, so the mismatch proves the pairing
    put('main.js', `a\n//# sourceMappingURL=maps/main.js.map?3872346a403b27a7${stamp(ID_A)}`);
    put('maps/main.js.map', mapJson({ debugId: ID_B }));
    const report = await run();
    expect(ids(report)).not.toContain('map.pointer-dangling');
    expect(ids(report)).toContain('stamp.map-id-mismatch');
    expect(ids(report)).not.toContain('map.hidden');
  });

  it('a query on a pointer to a map that is not there is still dangling, reported as written', async () => {
    put('main.js', `a\n//# sourceMappingURL=gone.js.map?abc${stamp(ID_A)}`);
    expect(find(await run(), 'map.pointer-dangling')?.details).toEqual({
      pointers: ['main.js -> gone.js.map?abc'],
    });
  });

  it('an excluded map named with a query is neither read nor dangling', async () => {
    put('main.js', `a\n//# sourceMappingURL=maps/main.js.map?x${stamp(ID_A)}`);
    put('maps/main.js.map', mapJson({ debugId: ID_B }));
    const report = await run({ exclude: ['maps/**'] });
    expect(ids(report)).not.toContain('map.pointer-dangling');
    expect(ids(report)).not.toContain('stamp.map-id-mismatch');
  });
});

describe('index (sectioned) source maps (round 10)', () => {
  // Sections must not overlap: each starts at a later generated line.
  const index = (sections: unknown[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      version: 3,
      sections: sections.map((s, i) =>
        typeof s === 'object' && s !== null && 'offset' in s
          ? { ...s, offset: { line: i * 10, column: 0 } }
          : s,
      ),
      ...extra,
    });
  const section = (sources: string[], content?: string[]) => ({
    offset: { line: 0, column: 0 },
    map: {
      version: 3,
      sources,
      ...(content ? { sourcesContent: content } : {}),
      names: [],
      mappings: 'AAAA',
    },
  });
  const pair = (map: string): void => {
    put('a.js', `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
    put('a.js.map', map);
  };

  it('sources live inside the sections: not map.no-sources, and the embedded content is counted', async () => {
    pair(index([section(['a.ts'], ['x']), section(['b.ts'], ['y'])], { debugId: ID_A }));
    const report = await run();
    expect(ids(report)).not.toContain('map.no-sources');
    expect(ids(report)).not.toContain('map.invalid');
    expect(find(report, 'map.sources-content')?.message).toContain('all 2 sources');
  });

  it('sections without sourcesContent and with sources not on disk: map.sources-unresolvable', async () => {
    pair(index([section(['a.ts']), section(['b.ts'], ['y'])], { debugId: ID_A }));
    const report = await run();
    expect(find(report, 'map.sources-unresolvable')?.details).toEqual({ unresolved: 1, total: 2 });
  });

  it('an index map whose sections carry no sources is still map.no-sources', async () => {
    pair(index([section([]), { offset: { line: 1, column: 0 }, url: 'x.map' }], { debugId: ID_A }));
    expect(ids(await run())).toContain('map.no-sources');
    pair(index([], { debugId: ID_A })); // no sections at all: nothing generated; the bundle `a` is real code: error
    expect(find(await run(), 'map.no-sources')?.severity).toBe('error');
    put('a.js', `export{a}from'./m.js';${stamp(ID_A)}`); // as a facade it is fine
    expect(find(await run(), 'map.no-sources')?.severity).toBe('info');
  });

  it('content stays aligned per section: a second source without content is the one reported', async () => {
    pair(index([section(['a.ts', 'b.ts'], ['x'])], { debugId: ID_A }));
    expect(find(await run(), 'map.sources-unresolvable')?.details).toEqual({
      unresolved: 1,
      total: 2,
    });
  });

  it('an empty top-level sources array falls through to the sections; a section without a map or sources is skipped', async () => {
    pair(
      index(
        [section(['a.ts'], ['x']), { offset: { line: 1, column: 0 }, map: { version: 3 } }, null],
        { debugId: ID_A, sources: [] },
      ),
    );
    const report = await run();
    expect(ids(report)).not.toContain('map.no-sources');
    expect(ids(report)).not.toContain('doctor.internal-error');
    expect(find(report, 'map.sources-content')?.message).toContain('all 1 sources');
  });

  it("each section's sources are resolved with the section's own sourceRoot", async () => {
    put('src/a.ts', 'x');
    const withRoot = {
      offset: { line: 0, column: 0 },
      map: { version: 3, sourceRoot: 'src/', sources: ['a.ts'], names: [], mappings: 'AAAA' },
    };
    pair(index([withRoot], { debugId: ID_A }));
    expect(ids(await run())).not.toContain('map.sources-unresolvable');
    put('src/a.ts', 'x');
    const wrongRoot = { ...withRoot, map: { ...withRoot.map, sourceRoot: 'nope/' } };
    pair(index([wrongRoot], { debugId: ID_A }));
    expect(ids(await run())).toContain('map.sources-unresolvable');
  });

  it('nested index maps: leaves are found at any depth, each with its own sourceRoot and content', async () => {
    put('lib/b.ts', 'y');
    const leaf = (root: string, sources: string[], content?: string[]) => ({
      offset: { line: 0, column: 0 },
      map: {
        version: 3,
        sourceRoot: root,
        sources,
        ...(content ? { sourcesContent: content } : {}),
        names: [],
        mappings: 'AAAA',
      },
    });
    const inner = {
      offset: { line: 5, column: 0 },
      map: { version: 3, sections: [leaf('lib/', ['b.ts'])] },
    };
    pair(index([leaf('', ['a.ts'], ['x']), inner], { debugId: ID_A }));
    const report = await run();
    expect(ids(report)).not.toContain('map.no-sources');
    expect(ids(report)).not.toContain('map.sources-unresolvable'); // b.ts is under lib/, via the leaf's root
    const wrong = {
      offset: { line: 5, column: 0 },
      map: { version: 3, sections: [leaf('nope/', ['b.ts'])] },
    };
    pair(index([leaf('', ['a.ts'], ['x']), wrong], { debugId: ID_A }));
    expect(find(await run(), 'map.sources-unresolvable')?.details).toEqual({
      unresolved: 1,
      total: 2,
    });
  });

  it('index maps are followed to a bounded depth (32): a leaf within it is found, one beyond it is not', async () => {
    const chain = (depth: number): string => {
      let map: Record<string, unknown> = {
        version: 3,
        sources: ['a.ts'],
        sourcesContent: ['x'],
        mappings: 'A',
      };
      for (let i = 0; i < depth; i++) {
        map = { version: 3, sections: [{ offset: { line: 0, column: 0 }, map }] };
      }
      return JSON.stringify({ ...map, debugId: ID_A });
    };
    pair(chain(30));
    expect(ids(await run())).not.toContain('map.no-sources');
    pair(chain(40));
    const report = await run();
    expect(ids(report)).toContain('map.no-sources');
    expect(ids(report)).not.toContain('doctor.internal-error');
  });

  it('top-level sources win over sections', async () => {
    pair(
      index([section(['z.ts'], ['z'])], {
        debugId: ID_A,
        sources: ['a.ts'],
        sourcesContent: ['x'],
        mappings: 'AAAA',
      }),
    );
    expect(find(await run(), 'map.sources-content')?.message).toContain('all 1 sources');
  });
});

// Windows does not allow a `?` in a path component: the fixture cannot be created there
describe.skipIf(process.platform === 'win32')(
  'a ? in the checked directory path (round 11)',
  () => {
    it('the pointer is judged on its own query, not on a ? anywhere in the absolute path', async () => {
      const weird = join(root, 'we?ird');
      mkdirSync(weird);
      const out = join(weird, 'dist');
      mkdirSync(out);
      writeFileSync(join(out, 'a.js'), `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
      writeFileSync(join(out, 'a.js.map'), mapJson({ debugId: ID_A }));
      const report = await diagnoseBuildOutput(out, { projectRoot: root, skipEnv: true });
      expect(ids(report)).not.toContain('map.pointer-outside-dir');
      expect(ids(report)).not.toContain('map.pointer-dangling');
      expect(ids(report)).not.toContain('map.hidden'); // the pointer paired a.js.map
      expect(report.summary.errors + report.summary.warnings).toBe(0);
    });
  },
);

describe('a scheme in sourceRoot (round 12)', () => {
  it('sourceRoot + source is one URL: webpack:/// + src/x.ts names <project>/src/x.ts', async () => {
    put('../src/x.ts', 'x');
    const body = { debugId: ID_A, sourcesContent: undefined, sources: ['src/x.ts'] };
    put('a.js', `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
    for (const sourceRoot of ['webpack:///', 'webpack://app/', 'webpack://app']) {
      put('a.js.map', mapJson({ ...body, sourceRoot }));
      expect(ids(await run()), sourceRoot).not.toContain('map.sources-unresolvable');
    }
    put('a.js.map', mapJson({ ...body, sourceRoot: 'webpack:///', sources: ['src/missing.ts'] }));
    expect(ids(await run())).toContain('map.sources-unresolvable');
  });
});

describe('symlinked HTML pages are scanned, or reported, never skipped silently (round 12)', () => {
  const sri = (bytes: string): string =>
    `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
  const stalePage = `<script src="a.js" integrity="${sri('older bytes')}"></script>`;

  it('a link to a page inside the directory is read through its real path (stale pin found)', async () => {
    put('a.js', `console.log(1);${stamp(ID_A)}`);
    // `a.js` from pages/ is pages/a.js (absent): only the link at the ROOT resolves this pin to the script under test
    put('pages/real.html', stalePage);
    symlinkSync(join(dist, 'pages', 'real.html'), join(dist, 'index.html'));
    const report = await run();
    expect(ids(report)).toContain('sri.mismatch');
  });

  it('a link that leads outside the directory (or dangles) is reported as not scanned', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    writeFileSync(join(root, 'outside.html'), stalePage);
    symlinkSync(join(root, 'outside.html'), join(dist, 'out.html'));
    symlinkSync(join(root, 'nowhere.html'), join(dist, 'dangling.html'));
    const finding = find(await run(), 'sri.html-skipped');
    expect(finding).toMatchObject({
      severity: 'warning',
      details: { files: ['dangling.html', 'out.html'] },
    });
    expect(ids(await run())).not.toContain('sri.mismatch');
  });
});

describe('sourcePath with a scheme sourceRoot (unit)', () => {
  it('a source that already carries its own scheme or is absolute ignores the root', () => {
    const map = '/p/dist';
    const proj = '/p';
    expect(sourcePath(map, 'webpack:///', 'src/x.ts', proj, posix)).toBe('/p/src/x.ts');
    expect(sourcePath(map, 'webpack:///', 'webpack://app/src/x.ts', proj, posix)).toBe(
      '/p/src/x.ts',
    );
    expect(sourcePath(map, 'webpack:///', 'file:///tmp/y.ts', proj, posix)).toBe('/tmp/y.ts');
    expect(sourcePath(map, 'webpack:///', '/abs/z.ts', proj, posix)).toBe('/abs/z.ts');
    expect(sourcePath(map, 'https://h/r', '/abs/z.ts', proj, posix)).toBe('/abs/z.ts');
    // a non-URL source with a single-colon scheme is not joined to the root either: it resolves from the map
    expect(sourcePath(map, 'webpack:///', 'node:fs', proj, posix)).toBe('/p/dist/webpack:/node:fs');
    // file URL semantics follow the path API it is given, not the host: a drive letter is a plain path segment here
    expect(sourcePath('/m', '', 'file:///C:/x/a.ts', '/p', posix)).toBe('/C:/x/a.ts');
  });
});

describe('round 13 review findings', () => {
  const sri = (bytes: string): string =>
    `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
  const pair = (map: string, bundle = 'a.js'): void => {
    put(bundle, `a\n//# sourceMappingURL=${bundle}.map${stamp(ID_A)}`);
    put(`${bundle}.map`, map);
  };

  it("--exclude applies to a READABLE page before its pins are collected (and cannot claim an included page's pin)", async () => {
    const js = `console.log(1);${stamp(ID_A)}`;
    put('app.js', js);
    const stale = `<script src="/app.js" integrity="${sri('older bytes')}"></script>`;
    put('a-legacy/x.html', stale.replace('/app.js', '../app.js'));
    expect(ids(await run())).toContain('sri.mismatch');
    expect(ids(await run({ exclude: ['a-legacy/**'] }))).not.toContain('sri.mismatch');
    expect(ids(await run({ exclude: ['a-legacy/**'] }))).not.toContain('output.exclude-unmatched');
    // an included page with the SAME pin is still judged although the excluded page sorts first
    put('index.html', stale.replace('/app.js', 'app.js'));
    const report = await run({ exclude: ['a-legacy/**'] });
    expect(find(report, 'sri.mismatch')?.details).toEqual({ scripts: ['app.js'] });
  });

  it('a map with no original positions (empty, generated-only, short segments) is map.invalid; a mixed one is fine', async () => {
    for (const mappings of ['', ';;;', 'A', 'AAA', 'AAAA;;AAAA', 'A,AAAA', 'AAAAA', 'AAAAIAAAA']) {
      pair(mapJson({ debugId: ID_A, mappings }));
      const invalid = find(await run(), 'map.invalid');
      const expectInvalid = ['', ';;;', 'A', 'AAA'].includes(mappings);
      expect(invalid !== undefined, `mappings ${JSON.stringify(mappings)}`).toBe(expectInvalid);
      if (expectInvalid) {
        expect(invalid?.message).toContain('original');
      }
    }
  });

  it('hasOriginalPosition: a segment needs four or more VLQ values (continuation bits respected)', () => {
    expect(hasOriginalPosition('AAAA')).toBe(true);
    expect(hasOriginalPosition('AAA')).toBe(false);
    expect(hasOriginalPosition('')).toBe(false);
    expect(hasOriginalPosition(',,;')).toBe(false);
    expect(hasOriginalPosition('A;AAAA')).toBe(true);
    expect(hasOriginalPosition('A,AAAA')).toBe(true);
    // `gB` is ONE value (g has the continuation bit): gBAAA is 4 values, gBAA is 3
    expect(hasOriginalPosition('gBAAA')).toBe(true);
    expect(hasOriginalPosition('gBAA')).toBe(false);
    expect(hasOriginalPosition('AAA$A')).toBe(false); // not base64: that segment is unusable
    expect(hasOriginalPosition('AA$A,AAAA')).toBe(true);
    expect(hasOriginalPosition('AAAA$')).toBe(false); // a bad character spoils the whole segment, wherever it is
  });

  it('hasOriginalPosition answers from the first usable segment without scanning (or splitting) the whole string', () => {
    const big = `AAAA${',AAAA'.repeat(5_000_000)}`; // ~25 MB: splitting it into 5M strings takes hundreds of ms
    big.charAt(big.length - 1); // V8 builds the string lazily: flatten it first, so only the scan is timed
    const started = performance.now();
    expect(hasOriginalPosition(big)).toBe(true);
    expect(performance.now() - started).toBeLessThan(100);
    // and the answer is the same when the usable segment is the last one
    expect(hasOriginalPosition(`${';'.repeat(1000)}AAA,AAAA`)).toBe(true);
    expect(hasOriginalPosition(`${'AAA;'.repeat(1000)}AAA`)).toBe(false);
  });

  it('index maps: at least one leaf must carry an original position', async () => {
    const leaf = (mappings: string, line: number) => ({
      offset: { line, column: 0 },
      map: { version: 3, sources: ['a.ts'], sourcesContent: ['x'], names: [], mappings },
    });
    pair(JSON.stringify({ version: 3, debugId: ID_A, sections: [leaf('', 0), leaf(';;', 5)] }));
    expect(find(await run(), 'map.invalid')?.message).toContain('original');
    pair(JSON.stringify({ version: 3, debugId: ID_A, sections: [leaf('', 0), leaf('AAAA', 5)] }));
    expect(ids(await run())).not.toContain('map.invalid');
    pair(JSON.stringify({ version: 3, debugId: ID_A, sections: [leaf('AAAA', 0), leaf('', 5)] }));
    expect(ids(await run())).not.toContain('map.invalid'); // any leaf counts, not just the last
  });

  it('one map reached through aliases in DIFFERENT directories has its relative sources checked against each', async () => {
    put(
      'real/app.js.map',
      mapJson({ debugId: ID_A, sourcesContent: undefined, sources: ['src/x.ts'] }),
    );
    put('a/src/x.ts', 'x'); // only a/ has the source
    for (const d of ['a', 'b']) {
      put(`${d}/app.js`, `a\n//# sourceMappingURL=app.js.map${stamp(ID_A)}`);
      symlinkSync(join(dist, 'real', 'app.js.map'), join(dist, d, 'app.js.map'));
    }
    const report = await run();
    const unresolved = report.findings.filter((f) => f.id === 'map.sources-unresolvable');
    // the real file itself (real/) has no src/x.ts either; a/ is the only base that does
    expect(unresolved.map((f) => f.file)).toEqual(['b/app.js.map', 'real/app.js.map']);
    expect(ids(report)).not.toContain('map.invalid');
  });

  it("aliases in different directories report a shared map's CONTENT and STRUCTURE once", async () => {
    const alias = (body: Record<string, unknown>): void => {
      put('real/app.js.map', mapJson({ debugId: ID_A, ...body }));
      for (const d of ['a', 'b']) {
        put(`${d}/app.js`, `a\n//# sourceMappingURL=app.js.map${stamp(ID_A)}`);
        if (!existsSync(join(dist, d, 'app.js.map'))) {
          symlinkSync(join(dist, 'real', 'app.js.map'), join(dist, d, 'app.js.map'));
        }
      }
    };
    const count = (report: DoctorReport, id: string): number =>
      report.findings.filter((f) => f.id === id && !(f.file ?? '').startsWith('real/')).length;
    alias({}); // content embedded
    expect(count(await run(), 'map.sources-content')).toBe(1);
    put('a/src/x.ts', 'x');
    put('b/src/x.ts', 'x');
    alias({ sourcesContent: undefined, sources: ['src/x.ts'] }); // not embedded, resolvable from both
    expect(count(await run(), 'map.sources-content')).toBe(1);
    alias({ version: 2 });
    expect(count(await run(), 'map.invalid')).toBe(1);
  });

  it('aliases in the SAME directory are still judged once', async () => {
    put('real/m.map', mapJson({ debugId: ID_A, sourcesContent: undefined, sources: ['src/x.ts'] }));
    for (const n of ['one', 'two']) {
      put(`${n}.js`, `a\n//# sourceMappingURL=${n}.map${stamp(ID_A)}`);
      symlinkSync(join(dist, 'real', 'm.map'), join(dist, `${n}.map`));
    }
    const report = await run();
    const aliases = report.findings.filter(
      (f) => f.id === 'map.sources-unresolvable' && !(f.file ?? '').startsWith('real/'),
    );
    expect(aliases).toHaveLength(1);
  });
});

describe('boundedMemo', () => {
  it('computes once per key, caches failures-as-values, and evicts the least recently used', async () => {
    const calls: string[] = [];
    const memo = boundedMemo(2, async (key: string) => {
      calls.push(key);
      return key.toUpperCase();
    });
    expect(await memo('a')).toBe('A');
    expect(await memo('a')).toBe('A');
    expect(await memo('b')).toBe('B');
    expect(await memo('a')).toBe('A'); // refreshes a: b is now the oldest
    expect(await memo('c')).toBe('C'); // evicts b
    expect(await memo('a')).toBe('A');
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(await memo('b')).toBe('B');
    expect(calls).toEqual(['a', 'b', 'c', 'b']);
  });

  it('shares an in-flight computation between concurrent callers', async () => {
    let runs = 0;
    const memo = boundedMemo(4, async (key: string) => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return key;
    });
    await Promise.all([memo('x'), memo('x'), memo('x')]);
    expect(runs).toBe(1);
  });
});

describe('walkDetailed on a path that does not exist', () => {
  it('does not throw: nothing found, the root itself reported as unreadable', async () => {
    const missing = join(root, 'no-such-dir');
    expect(await walk(missing)).toEqual([]);
    expect((await walkDetailed(missing)).unreadable).toEqual(['.']);
  });
});

describe('symlinked directories are followed inside the output directory, reported when they leave it (round 14)', () => {
  const unstampedChunk = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk.js'), 'unstamped');
  };

  it('a link to a directory INSIDE the output is walked: its scripts are audited (once), under the link name', async () => {
    put('app.js', `a${stamp(ID_A)}`);
    // the target lives where the plain walk never goes (node_modules), so only FOLLOWING the link can find it
    unstampedChunk(join(dist, 'node_modules', 'real-legacy'));
    symlinkSync(join(dist, 'node_modules', 'real-legacy'), join(dist, 'legacy'));
    const report = await run();
    expect(ids(report)).toContain('stamp.missing-debug-id');
    expect(report.summary.bundles).toBe(2); // app.js and ONE chunk.js
    expect(doctorExitCode(report, true)).toBeGreaterThanOrEqual(1);
  });

  it('a link to a directory OUTSIDE is output.dir-unreadable (exit 2), which --exclude can clear', async () => {
    put('app.js', `a${stamp(ID_A)}`);
    unstampedChunk(join(root, 'legacy-out'));
    symlinkSync(join(root, 'legacy-out'), join(dist, 'legacy'));
    const report = await run();
    expect(find(report, 'output.dir-unreadable')).toMatchObject({
      severity: 'error',
      details: { directories: ['legacy'] },
    });
    expect(doctorExitCode(report, false)).toBe(2);
    expect(ids(await run({ exclude: ['legacy/**'] }))).not.toContain('output.dir-unreadable');
  });

  it('a link that loops back to an ancestor (or to the root) is not walked twice and is not an error', async () => {
    put('app.js', `a${stamp(ID_A)}`);
    put('sub/x.js', `a${stamp(ID_B)}`);
    symlinkSync(dist, join(dist, 'sub', 'up'));
    symlinkSync('.', join(dist, 'self'));
    const report = await run();
    expect(report.summary.bundles).toBe(2);
    expect(ids(report)).not.toContain('output.dir-unreadable');
  });

  it('a dangling link, and a link to a FILE, are ignored; node_modules and .git links are never followed', async () => {
    put('app.js', `a${stamp(ID_A)}`);
    symlinkSync(join(root, 'nowhere'), join(dist, 'dangling'));
    symlinkSync(join(dist, 'app.js'), join(dist, 'filelink'));
    unstampedChunk(join(root, 'ext'));
    symlinkSync(join(root, 'ext'), join(dist, 'node_modules'));
    symlinkSync(join(root, 'ext'), join(dist, '.git'));
    const report = await run();
    expect(ids(report)).not.toContain('output.dir-unreadable');
    expect(report.summary.bundles).toBe(1);
  });

  it('pages under a followed link are scanned for SRI pins; under an outside link they are reported', async () => {
    const sri = (bytes: string): string =>
      `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
    put('app.js', `console.log(1);${stamp(ID_A)}`);
    const page = `<script src="../app.js" integrity="${sri('older bytes')}"></script>`;
    put('node_modules/x/p.html', page); // only reachable through the link
    symlinkSync(join(dist, 'node_modules', 'x'), join(dist, 'pages'));
    expect(ids(await run())).toContain('sri.mismatch');
    mkdirSync(join(root, 'ext-pages'));
    writeFileSync(join(root, 'ext-pages', 'p.html'), page);
    symlinkSync(join(root, 'ext-pages'), join(dist, 'external'));
    expect(find(await run(), 'output.dir-unreadable')?.details).toEqual({
      directories: ['external'],
    });
  });

  it('a followed link inside a fenced project directory still obeys the fence by name', async () => {
    put('package.json', '{"name":"p"}');
    put('app.js', `a${stamp(ID_A)}`);
    unstampedChunk(join(dist, 'node_modules', 'real')); // not walked by anything else
    symlinkSync(join(dist, 'node_modules', 'real'), join(dist, 'tests'));
    const here = process.cwd();
    process.chdir(dist);
    try {
      const report = await run();
      expect(find(report, 'output.walk-fenced')?.details).toEqual({ directories: ['tests'] });
    } finally {
      process.chdir(here);
    }
  });
});

// paths relative to the output directory, always with `/` (a Windows host returns backslashes)
const relFiles = (files: string[]): string[] =>
  files.map((f) => relative(dist, f).split(sep).join('/'));

describe('a REAL directory always wins over a link to it, whatever the names sort like (round 15)', () => {
  for (const linkName of ['latest', 'zlatest']) {
    it(`link "${linkName}" -> v2: files are walked, reported and excludable under the REAL path v2/`, async () => {
      put('v2/chunk.js', 'unstamped');
      put('app.js', `a${stamp(ID_A)}`);
      symlinkSync(join(dist, 'v2'), join(dist, linkName));
      const files = relFiles(await walk(dist));
      expect(files).toEqual(['app.js', 'v2/chunk.js']);
      const report = await run();
      expect(report.summary.bundles).toBe(2);
      // the exclusion written for the real path works; one written for the alias does not
      expect(ids(await run({ exclude: ['v2/**'] }))).not.toContain('stamp.missing-debug-id');
      expect(ids(await run({ exclude: [`${linkName}/**`] }))).toContain('stamp.missing-debug-id');
    });
  }

  it('a link reached BEFORE a deeper real directory it points to still loses to it', async () => {
    put('a/b/c/chunk.js', 'unstamped'); // real, deep
    symlinkSync(join(dist, 'a', 'b', 'c'), join(dist, '0first')); // sorts before "a", the real parent
    symlinkSync(join(dist, 'a', 'b', 'c'), join(dist, 'zlast')); // and one that sorts after
    const files = relFiles(await walk(dist));
    expect(files).toEqual(['a/b/c/chunk.js']);
  });

  it('a link to a directory that is NOT reachable as a real directory (skipped by name) is still followed, once', async () => {
    put('node_modules/real/chunk.js', 'unstamped');
    symlinkSync(join(dist, 'node_modules', 'real'), join(dist, 'a-link'));
    symlinkSync(join(dist, 'node_modules', 'real'), join(dist, 'b-link'));
    expect(relFiles(await walk(dist))).toEqual(['a-link/chunk.js']);
  });
});

describe('round 16 review findings', () => {
  const unstampedChunk = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chunk.js'), 'unstamped');
  };

  it('a link NAMED like a script that points to a directory is followed as a directory', async () => {
    put('app.js', `a${stamp(ID_A)}`);
    unstampedChunk(join(dist, 'node_modules', 'assets'));
    symlinkSync(join(dist, 'node_modules', 'assets'), join(dist, 'assets.js'));
    symlinkSync(join(dist, 'node_modules', 'assets'), join(dist, 'assets.map'));
    const report = await run();
    expect(ids(report)).toContain('stamp.missing-debug-id'); // the chunk inside was audited
    expect(ids(report)).not.toContain('output.unreadable'); // and assets.js was not read as a bundle
    expect(report.summary.bundles).toBe(2);
    expect(relFiles(await walk(dist))).toEqual(['app.js', 'assets.js/chunk.js']);
  });

  it('a script link to a regular file is still a bundle; a dangling one is still reported', async () => {
    put('real.js', `a${stamp(ID_A)}`);
    symlinkSync(join(dist, 'real.js'), join(dist, 'alias.js'));
    symlinkSync(join(root, 'nowhere.js'), join(dist, 'dangling.js'));
    const report = await run();
    expect(find(report, 'output.unreadable')?.details).toEqual({
      files: ['dangling.js could not be resolved (ENOENT)'],
    });
  });

  it('fenced: a real directory beyond the depth cap does not stop a SHALLOWER link to it from being audited', async () => {
    put('package.json', '{"name":"p"}');
    put('app.js', `a${stamp(ID_A)}`);
    unstampedChunk(join(dist, 'a', 'b', 'c', 'd', 'e', 'f', 'g')); // depth 7: over the cap
    symlinkSync(join(dist, 'a', 'b', 'c', 'd', 'e', 'f', 'g'), join(dist, 'shortcut'));
    const here = process.cwd();
    process.chdir(dist);
    try {
      const report = await run();
      expect(ids(report)).toContain('stamp.missing-debug-id');
      expect(relFiles(await walk(dist))).toEqual(['app.js', 'shortcut/chunk.js']);
      // the link walked it: it is no longer "not searched"
      expect(find(report, 'output.walk-fenced')).toBeUndefined();
    } finally {
      process.chdir(here);
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'a directory exclude is not satisfied by a pattern that only matches the probe directory names',
    async () => {
      put('a.js', `a${stamp(ID_A)}`);
      put('vendor/app.js', 'x');
      chmodSync(join(dist, 'vendor'), 0o000);
      try {
        for (const pattern of ['vendor/zz-probe-1/**', 'vendor/zz-1/**', 'vendor/zz-2/zz-3/**']) {
          const kept = find(await run({ exclude: [pattern] }), 'output.dir-unreadable')?.details;
          expect(kept, pattern).toEqual({ directories: ['vendor'] });
        }
        expect(ids(await run({ exclude: ['vendor/**'] }))).not.toContain('output.dir-unreadable');
      } finally {
        chmodSync(join(dist, 'vendor'), 0o700);
      }
    },
  );

  it('a mapping whose source index is outside the leaf sources has no original position', async () => {
    const pairMap = (mappings: string, sources: string[] = ['a.ts']): void => {
      put('a.js', `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
      put(
        'a.js.map',
        mapJson({ debugId: ID_A, mappings, sources, sourcesContent: sources.map(() => 'x') }),
      );
    };
    pairMap('ACAA'); // source index 1 of 1: out of range
    expect(find(await run(), 'map.invalid')?.message).toContain('original');
    pairMap('AAAA');
    expect(ids(await run())).not.toContain('map.invalid');
    pairMap('ACAA', ['a.ts', 'b.ts']); // index 1 of 2
    expect(ids(await run())).not.toContain('map.invalid');
    pairMap('ADAA'); // index -1
    expect(ids(await run())).toContain('map.invalid');
    pairMap('AAAA,ACAA'); // the SECOND segment is out of range, the first is fine
    expect(ids(await run())).not.toContain('map.invalid');
  });

  it('hasOriginalPosition decodes the cumulative source index (deltas) across segments', () => {
    expect(hasOriginalPosition('ACAA', 1)).toBe(false);
    expect(hasOriginalPosition('ACAA', 2)).toBe(true);
    expect(hasOriginalPosition('ACAA')).toBe(true); // no count given: any index
    expect(hasOriginalPosition('ADAA', 5)).toBe(false); // -1
    expect(hasOriginalPosition('AAAA,ADAA,AEAA', 2)).toBe(true); // first segment already fine
    expect(hasOriginalPosition('AEAA', 2)).toBe(false); // +2: index 2 of 2
    expect(hasOriginalPosition('AEAA', 3)).toBe(true);
    expect(hasOriginalPosition('AEAA;AFAA', 2)).toBe(true); // +2 then -2: the second segment lands on index 0
    // an unusable segment (bad character) does not move the running source index
    expect(hasOriginalPosition('AEA$,AAAA', 2)).toBe(true);
    // a segment whose generated column is negative is skipped before its source delta applies (ECMA-426)
    expect(hasOriginalPosition('DCAA;ADAA', 1)).toBe(false);
    expect(hasOriginalPosition('DCAA;ACAA', 3)).toBe(true); // the second line's own column is fine: index 1 of 3
    expect(hasOriginalPosition('DAAA;AAAA', 1)).toBe(true); // the generated column resets at `;`
    expect(hasOriginalPosition('E,DAAA', 1)).toBe(true); // the first segment only sets column 2; the next maps at column 1
    expect(hasOriginalPosition('DAAA', 1)).toBe(false);
    expect(hasOriginalPosition('E,HAAA', 1)).toBe(false); // its only candidate maps at column 2-3 = -1
    expect(hasOriginalPosition('E,BAAA', 1)).toBe(false); // `B` is sign-bit-only: -2147483648, not -0
    expect(hasOriginalPosition('E,BAAA', 5)).toBe(false);
    expect(hasOriginalPosition('BAAA', 1)).toBe(false);
    expect(hasOriginalPosition('EAAA,BAAA', 1)).toBe(true); // the first segment is already fine
    // only a segment with an original line and column moves the running source index (ECMA-426)
    expect(hasOriginalPosition('AC,EDAA', 1)).toBe(false); // AC (2 values) must not commit +1
    expect(hasOriginalPosition('AEAA$,AAAA', 2)).toBe(true); // a segment with a bad character commits nothing
    expect(hasOriginalPosition('ACA,EDAA', 1)).toBe(false); // nor three values
    expect(hasOriginalPosition('ACAA,EDAA', 3)).toBe(true); // four values commit: 1 then 1+(-1)=0
    // continuation digits: 'gB' is 16, so the source delta below is 16
    expect(hasOriginalPosition('AgBAA', 17)).toBe(true);
    expect(hasOriginalPosition('AgBAA', 16)).toBe(false);
  });

  it('map.too-large reports the limit that was ACTUALLY applied (never above the read ceiling)', async () => {
    put('a.js', `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
    truncateSync(put('a.js.map', ''), READ_CEILING + 1024 * 1024);
    const report = await run({ maxMapBytes: 2 ** 40 });
    const finding = find(report, 'map.too-large');
    expect(finding?.details).toMatchObject({ limit: READ_CEILING });
    expect(finding?.message).toContain('most Node can hold');
    const low = find(await run({ maxMapBytes: 1 }), 'map.too-large');
    expect(low?.details).toMatchObject({ limit: 1 });
  });

  it('a NaN read limit never disables the ceiling: the reader refuses it, the doctor uses its default', async () => {
    put('a.js', `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
    put('a.js.map', mapJson({ debugId: ID_A }));
    const file = join(dist, 'a.js.map');
    expect(await readRegularFile(file, Number.NaN)).toEqual({
      ok: false,
      reason: 'has an invalid read limit',
    });
    expect(await readRegularFile(file, 100, Number.NaN)).toEqual({
      ok: false,
      reason: 'has an invalid read limit',
    });
    const report = await run({ maxMapBytes: Number.NaN, maxBundleBytes: Number.NaN });
    expect(ids(report)).not.toContain('map.too-large');
    expect(ids(report)).not.toContain('map.unreadable');
    expect(report.summary).toMatchObject({ bundles: 1, maps: 1, errors: 0 });
  });
});

describe('output.walk-fenced lists only what was really not walked (round 17)', () => {
  const inDist = async <T>(fn: () => Promise<T>): Promise<T> => {
    const here = process.cwd();
    process.chdir(dist);
    try {
      return await fn();
    } finally {
      process.chdir(here);
    }
  };
  const fencedWalk = (): Promise<{ files: string[]; skipped: string[] }> => walkDetailed(dist);

  it('an alias (beyond the depth cap) of a directory that WAS walked is not listed', async () => {
    put('package.json', '{"name":"p"}');
    put('v2/app.js', `a${stamp(ID_A)}`);
    mkdirSync(join(dist, 'a/b/c/d/e/f'), { recursive: true });
    symlinkSync(join(dist, 'v2'), join(dist, 'a/b/c/d/e/f/latest'));
    const walked = await inDist(fencedWalk);
    expect(relFiles(walked.files)).toEqual(['v2/app.js']);
    expect(walked.skipped).toEqual([]);
  });

  it('a deep real directory that a shallower link then walks is not listed either', async () => {
    put('package.json', '{"name":"p"}');
    put('a/b/c/d/e/f/g/app.js', `a${stamp(ID_A)}`);
    symlinkSync(join(dist, 'a/b/c/d/e/f/g'), join(dist, 'x'));
    const walked = await inDist(fencedWalk);
    expect(relFiles(walked.files)).toEqual(['x/app.js']);
    expect(walked.skipped).toEqual([]);
  });

  it('a directory nothing walked is still listed (depth cap and fenced names)', async () => {
    put('package.json', '{"name":"p"}');
    put('a/b/c/d/e/f/g/app.js', 'x');
    put('tests/t.js', 'x');
    const walked = await inDist(fencedWalk);
    expect(walked.skipped).toEqual(['a/b/c/d/e/f/g', 'tests']);
  });

  it('a fenced-name directory that a link DOES walk is not listed', async () => {
    put('package.json', '{"name":"p"}');
    put('tests/t.js', 'x');
    symlinkSync(join(dist, 'tests'), join(dist, 'viewer'));
    const walked = await inDist(fencedWalk);
    expect(relFiles(walked.files)).toEqual(['viewer/t.js']);
    expect(walked.skipped).toEqual([]);
  });
});

describe('a facade or empty chunk has an empty map and that is healthy (round 18)', () => {
  const rollupEmpty = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      version: 3,
      file: 'index.js',
      sources: [],
      sourcesContent: [],
      names: [],
      mappings: '',
      ...extra,
    });
  const pairOne = (map: string): void => {
    put('index.js', `export{a}from'./main.js';\n//# sourceMappingURL=index.js.map${stamp(ID_A)}`);
    put('index.js.map', map);
  };

  it('the Rollup facade map (sources [], mappings "") is an info, not an error, and the run passes --strict', async () => {
    pairOne(rollupEmpty({ debugId: ID_A }));
    const report = await run();
    expect(find(report, 'map.no-sources')).toMatchObject({
      severity: 'info',
      file: 'index.js.map',
    });
    expect(find(report, 'map.no-sources')?.message).toContain('nothing to map');
    expect(report.summary).toMatchObject({ errors: 0, warnings: 0 });
    expect(doctorExitCode(report, true)).toBe(0);
  });

  it('a chunk with REAL code and an empty map is still an error (a placeholder map, not a facade)', async () => {
    put(
      'main.js',
      `export function boom(){throw new Error('x')}\nconsole.log(1);\n//# sourceMappingURL=main.js.map${stamp(ID_A)}`,
    );
    put('main.js.map', rollupEmpty({ debugId: ID_A, mappings: ';;;;;;' }));
    const report = await run();
    expect(find(report, 'map.no-sources')?.severity).toBe('error');
    expect(doctorExitCode(report, false)).toBe(2);
  });

  it('isFacadeCode: only imports, re-exports and comments (and the Bugsee registration) are a facade', () => {
    for (const facade of [
      '',
      '  \n// nothing here\n/* or here */',
      "export{a}from'./main.js';",
      'export { a, b as c } from "./main.js";\n',
      "export * from './x.js'; export * as ns from './y.js'",
      "import './side-effect.js';",
      "import{a}from'./main.js';export{a};",
      "import a, { b } from './m.js'\nimport * as c from './c.js'\nexport { a, b, c }",
      `export{a}from'./main.js';\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`,
      // Rollup's CommonJS output
      "'use strict';\n\nvar main = require('./main.js');\n\nexports.a = main.a;\nexports.b = main.b;\n",
      "'use strict';\nObject.defineProperty(exports, '__esModule', { value: true });\nvar main = require('./main.js');\nexports.a = main.a;",
      '"use strict";require("./side-effect.cjs");',
      "'use strict';\nvar m = require('./m.js');\nObject.defineProperty(exports, 'a', {\n  enumerable: true,\n  get: function () { return m.a; }\n});",
      "module.exports = require('./main.cjs');",
      "const main = require('./main.js');\nexports.default = main;",
    ]) {
      expect(isFacadeCode(facade), JSON.stringify(facade)).toBe(true);
    }
    for (const code of [
      'export function f(){}',
      'export const a = 1;',
      "export { a } from './m.js'; console.log(1)",
      "import { a } from './m.js'; a();",
      'var x = 1; export { x }',
      'export default function(){}',
      "export { a } from './m.js' + 'x'",
      'console.log(1)',
      // CommonJS that is real code
      "'use strict';\nvar m = require('./m.js');\nexports.f = function(){ return 1 };",
      "'use strict';\nrequire('./m.js')();",
      "var m = require('./m.js') + 1;",
      'exports.a = main.a(); ',
      "Object.defineProperty(exports, 'a', { get: function () { sideEffect(); return 1; } });",
    ]) {
      expect(isFacadeCode(code), JSON.stringify(code)).toBe(false);
    }
  });

  it("isFacadeCode: Rollup's CommonJS export-star loop and interop helpers are facades", () => {
    const exportStar = `'use strict';

var lodash = require('lodash');
var util = require('./util.js');

exports.u = util.u;
Object.keys(lodash).forEach(function (k) {
  if (k !== 'default' && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
    enumerable: true,
    get: function () { return lodash[k]; }
  });
});
`;
    const interop = `'use strict';

function _interopNamespaceDefault(e) {
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () { return e[k]; }
        });
      }
    });
  }
  n.default = e;
  return Object.freeze(n);
}

function _interopDefault(e) { return e && e.__esModule ? e : { default: e }; }

var lodash = require('lodash');
var lodash__namespace = /*#__PURE__*/_interopNamespaceDefault(lodash);
var x = require('x');

exports.lodash = lodash__namespace;
exports.x = _interopDefault(x);
`;
    expect(isFacadeCode(exportStar)).toBe(true);
    expect(isFacadeCode(interop)).toBe(true);
    expect(isFacadeCode(`${exportStar}${stamp(ID_A)}`)).toBe(true);
    // the same blocks with something that DOES something are not
    expect(
      isFacadeCode(exportStar.replace('return lodash[k];', 'track(k); return lodash[k];')),
    ).toBe(false);
    expect(isFacadeCode(exportStar.replace('Object.keys(lodash)', 'doIt(lodash)'))).toBe(false);
    expect(isFacadeCode(interop.replace('Object.freeze(n)', 'sideEffect(n)'))).toBe(false);
    // a helper a minifier renamed is still a helper (it is interop-shaped); one that is not interop-shaped is code
    expect(isFacadeCode(interop.replaceAll('_interopDefault', 'doThing'))).toBe(true);
    expect(isFacadeCode(interop.replace('function _interopDefault', 'function doThing'))).toBe(
      false,
    ); // the call is then unresolved

    expect(isFacadeCode('function doThing(e) { return e; }\nexports.d = doThing(x);')).toBe(false);
    expect(
      isFacadeCode('function doThing(e) { return e.__esModule; }\nexports.d = doThing(x);'),
    ).toBe(true);
    expect(
      isFacadeCode('function doThing(e) { return e.__esModule; }\nexports.d = other(x);'),
    ).toBe(false);
    expect(
      isFacadeCode('function doThing(e) { return track(e.__esModule); }\nexports.d = doThing(x);'),
    ).toBe(false);
    expect(isFacadeCode(`${exportStar}\nconsole.log('hi');`)).toBe(false);
    expect(isFacadeCode('var x = 1;\nexports.x = x;')).toBe(false); // a value of its own
  });

  it("isFacadeCode: Rollup's es2015 output (arrow getters, for-in, const arrow helper) is a facade", () => {
    const es2015 = `'use strict';

const _interopNamespaceDefault = (e) => {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: 'Module' } });
  if (e) {
    for (const k in e) {
      if (k !== 'default') {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
};
const _interopDefault = e => e && e.__esModule ? e : { default: e };

const lodash = require('lodash');
const dep3 = require('dep3');
const util = require('./util.js');
const lodash__namespace = /*#__PURE__*/_interopNamespaceDefault(lodash);

exports.u = util.u;
Object.keys(lodash).forEach((k) => {
  if (k !== 'default' && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
    enumerable: true,
    get: () => lodash[k]
  });
});
Object.defineProperty(exports, 'named', {
  enumerable: true,
  get: () => dep3.named
});
exports.ns = lodash__namespace;
exports.d = _interopDefault(dep3);
`;
    expect(isFacadeCode(es2015)).toBe(true);
    expect(
      isFacadeCode("Object.defineProperty(exports, 'a', { enumerable: true, get: () => x.a });"),
    ).toBe(true);
    expect(
      isFacadeCode('const _interopDefault = e => e && e.__esModule ? e : { default: e };'),
    ).toBe(true);
    expect(isFacadeCode('const _interopDefault = function (e) { return e; };')).toBe(true);
    // look-alikes that DO something
    expect(isFacadeCode(es2015.replace('get: () => dep3.named', 'get: () => dep3.named()'))).toBe(
      false,
    );
    expect(isFacadeCode(es2015.replace('get: () => lodash[k]', 'get: () => track(k)'))).toBe(false);
    expect(
      isFacadeCode(es2015.replace('for (const k in e) {', 'for (const k in track(e)) {')),
    ).toBe(false);
    expect(
      isFacadeCode(es2015.replace("if (k !== 'default') {", "if (k !== 'default') { track(k);")),
    ).toBe(false);
    expect(isFacadeCode(es2015.replaceAll('_interopDefault', 'doThing'))).toBe(true); // renamed, but still interop-shaped
    expect(
      isFacadeCode(es2015.replace('const _interopDefault = e =>', 'const doThing = e =>')),
    ).toBe(false); // the call is then unresolved
    expect(
      isFacadeCode(
        es2015
          .replace(
            'const _interopDefault = e => e && e.__esModule ? e : { default: e };',
            'const doThing = e => e;',
          )
          .replace('exports.d = _interopDefault(dep3)', 'exports.d = doThing(dep3)'),
      ),
    ).toBe(false);
    expect(isFacadeCode('const _interopDefault = e => track(e);')).toBe(false);
    expect(isFacadeCode('const _interopDefault = 1;')).toBe(false);
    expect(isFacadeCode('const doThing = e => e;')).toBe(false);
    expect(isFacadeCode('exports.a = () => 1;')).toBe(false); // an arrow that is not a getter
    expect(
      isFacadeCode("Object.defineProperty(exports, 'a', { enumerable: true, value: () => x });"),
    ).toBe(false);
    expect(isFacadeCode('for (const k in x) { exports[k] = x[k]; }')).toBe(false); // a loop at top level is code
    expect(isFacadeCode('function _interopX(e) { for (var k in e) { k = 1; } return e; }')).toBe(
      true,
    );
    expect(
      isFacadeCode(
        'function _interopX(e) { var k; for (k in e) { Object.defineProperty(e, k, {}); } return e; }',
      ),
    ).toBe(true);
    expect(
      isFacadeCode(
        'function _interopX(e) { for (k in e) { Object.defineProperty(e, k, {}); } return e; }',
      ),
    ).toBe(false); // an undeclared target is a write to a global
    expect(isFacadeCode('function _interopX(e) { for (const [a, b] in e) { } return e; }')).toBe(
      false,
    );
    expect(
      isFacadeCode(
        'function _interopX(e) { for (const k in e) { } for (const k of e) { } return e; }',
      ),
    ).toBe(false); // for-of
    expect(isFacadeCode('function _interopX(e) { for (const k, j in e) { } return e; }')).toBe(
      false,
    ); // not valid, parse error
  });

  it('isFacadeCode: shapes that look like a re-export but are not', () => {
    const loop = (inner: string, extra = ''): string =>
      `Object.keys(x).forEach(function (k) { ${inner} }${extra});`;
    const define =
      'Object.defineProperty(exports, k, { enumerable: true, get: function () { return x[k]; } });';
    expect(isFacadeCode(loop(`if (k !== 'default') ${define}`))).toBe(true); // the real shape
    expect(isFacadeCode("Object['keys'](x);")).toBe(false); // computed callee
    expect(isFacadeCode('Object[keys](x);')).toBe(false);
    expect(isFacadeCode('var a = x.y;')).toBe(false); // a reference is not a call
    expect(isFacadeCode('var a;')).toBe(false);
    expect(isFacadeCode(loop(define, ', y'))).toBe(false); // an extra forEach argument
    expect(isFacadeCode('require(x);')).toBe(false); // not a literal specifier
    expect(isFacadeCode("require('a', 'b');")).toBe(false);
    expect(isFacadeCode("var m = require('a', 'b');")).toBe(false);
    expect(
      isFacadeCode(
        "Object.defineProperty(exports, 'a', { enumerable: true, value: function () { return x; } });",
      ),
    ).toBe(false);
    expect(isFacadeCode(loop(`if (k) ${define} else { track(k); }`))).toBe(false); // an impure else
    expect(isFacadeCode(loop(`if (k) ${define} else ${define}`))).toBe(true);
    expect(isFacadeCode('exports.n += 1;')).toBe(false); // not a plain assignment
    expect(
      isFacadeCode(
        'Object.keys(x).forEach(function ([k]) { Object.defineProperty(exports, k, {}); });',
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        'Object.keys(x).forEach(function (k, i) { Object.defineProperty(exports, k, {}); });',
      ),
    ).toBe(true);
    expect(
      isFacadeCode('Object.keys(x).forEach(k => Object.defineProperty(exports, k, {}));'),
    ).toBe(true); // an arrow
    expect(isFacadeCode('Object.keys(x).forEach(k => track(k));')).toBe(false);
    expect(isFacadeCode('Object.keys(x).forEach(function (k) { return; });')).toBe(true);
    expect(isFacadeCode('Object.keys(x).forEach(function (k) { return track(k); });')).toBe(false);
    expect(isFacadeCode('Object.keys(x).forEach(function (k) { while (k) {} });')).toBe(false); // a loop is code
    const interopDefault = 'function _interopDefault(e){return e&&e.__esModule?e:{default:e}}';
    expect(isFacadeCode(`${interopDefault}var a = require('x'), b = _interopDefault(a);`)).toBe(
      true,
    );
    expect(isFacadeCode("var a = require('x'), b = _interopDefault(a);")).toBe(false); // a name alone is no helper
    expect(isFacadeCode("var a = 1, b = require('x');")).toBe(false);
    expect(isFacadeCode("var [a] = require('x');")).toBe(false); // destructuring is not a plain binding
    expect(isFacadeCode("var a = k ? require('x') : require('y');")).toBe(false); // not a plain call
    expect(isFacadeCode('exports.a = k ? x.a : y.a;')).toBe(true);
    expect(isFacadeCode("exports.a = !x && typeof y === 'undefined' ? x.a : void 0;")).toBe(true);
    expect(isFacadeCode('exports.a = x[k];')).toBe(true);
    expect(isFacadeCode('exports.a = x[track()];')).toBe(false);
    expect(isFacadeCode('exports.a = {};')).toBe(true);
    expect(isFacadeCode("exports.a = { b: x.b, 'c': 1 };")).toBe(true);
    expect(isFacadeCode('exports.a = { ...x };')).toBe(false); // a spread is not a property
    expect(isFacadeCode('exports.a = x.a++ ;')).toBe(false);
    expect(isFacadeCode('exports.a = `t`;')).toBe(false);
    expect(isFacadeCode('exports.a = Object.keys(x);')).toBe(true);
    expect(isFacadeCode('export default 1;')).toBe(false);
    expect(isFacadeCode('class A {}')).toBe(false);
  });

  it('isFacadeCode round 19: forEach only on Object.keys(...), assignments only to CommonJS exports', () => {
    expect(isFacadeCode("const plugins = require('./plugins'); plugins.forEach(() => {});")).toBe(
      false,
    );
    expect(isFacadeCode('Object.keys(x).forEach(() => {});')).toBe(true);
    expect(isFacadeCode('Object.values(x).forEach(() => {});')).toBe(false);
    expect(isFacadeCode("require('./x').forEach(() => {});")).toBe(false);
    expect(isFacadeCode('globalThis.appReady = true;')).toBe(false);
    expect(isFacadeCode('x.a = main.a;')).toBe(false);
    expect(isFacadeCode('exports = main;')).toBe(false);
    expect(isFacadeCode("exports['a'] = main.a;")).toBe(true);
    expect(isFacadeCode('module.exports.a = main.a;')).toBe(true);
    expect(isFacadeCode("module.exports = require('./m.cjs');")).toBe(true);
    expect(isFacadeCode('module.x = main.a;')).toBe(false);
    expect(isFacadeCode('exports.a = exports.b = main.a;')).toBe(false); // a chained assignment is not Rollup's
    expect(isFacadeCode('ok && (globalThis.x = 1);')).toBe(false);
    expect(isFacadeCode('exports.a = (globalThis.x = 1);')).toBe(false);
  });

  it("isFacadeCode round 19: Rollup's `&&` chain (externalLiveBindings: false) and defineProperties", () => {
    const chain = `Object.prototype.hasOwnProperty.call(ext, '__proto__') &&
  !Object.prototype.hasOwnProperty.call(exports, '__proto__') &&
  Object.defineProperty(exports, '__proto__', { enumerable: true, value: ext['__proto__'] });`;
    expect(isFacadeCode(chain)).toBe(true);
    expect(isFacadeCode(chain.replace('Object.defineProperty(exports', 'track(exports'))).toBe(
      false,
    );
    expect(isFacadeCode(chain.replace('Object.prototype.hasOwnProperty.call(ext', 'has(ext'))).toBe(
      false,
    );
    expect(isFacadeCode('x && y;')).toBe(false); // a bare reference chain does nothing a facade needs
    expect(isFacadeCode('ok && track();')).toBe(false);
    expect(isFacadeCode("ok || Object.defineProperty(exports, 'a', {});")).toBe(true);
    expect(
      isFacadeCode(
        "Object.defineProperties(exports, { __esModule: { value: true }, [Symbol.toStringTag]: { value: 'Module' } });",
      ),
    ).toBe(true);
    expect(isFacadeCode('Object.defineProperties(exports, { [track()]: { value: true } });')).toBe(
      false,
    );
    // computed property keys are code too
    expect(
      isFacadeCode("Object.defineProperty(exports, 'a', { [track()]: true, get: () => dep.a });"),
    ).toBe(false);
    expect(
      isFacadeCode(
        "Object.defineProperty(exports, 'a', { [Symbol.toStringTag]: 'Module', get: () => dep.a });",
      ),
    ).toBe(true);
  });

  it('isFacadeCode round 19: AMD define(...) wrapping a facade body', () => {
    const star =
      "Object.keys(ext).forEach(function (k) { if (k !== 'default' && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, { enumerable: true, get: function () { return ext[k]; } }); });";
    const amd = (body: string, head = "['exports', './main.js', 'ext']"): string =>
      `define(${head}, (function (exports, main, ext) { 'use strict'; ${body} }));`;
    expect(isFacadeCode(amd(`exports.a = main.a; ${star}`))).toBe(true);
    expect(isFacadeCode(amd('exports.a = main.a;', "'id', ['exports', './main.js', 'ext']"))).toBe(
      true,
    );
    expect(isFacadeCode(amd('exports.a = main.a;', "['exports', './main.js']"))).toBe(true);
    expect(isFacadeCode(amd('exports.a = main.a; track();'))).toBe(false);
    expect(isFacadeCode(amd('globalThis.x = 1;'))).toBe(false);
    expect(isFacadeCode(amd('define([], function () {});'))).toBe(false); // no nesting
    expect(isFacadeCode(amd('exports.a = main.a;', 'deps'))).toBe(false); // not an array of literals
    expect(isFacadeCode(amd('exports.a = main.a;', '[dep]'))).toBe(false);
    expect(isFacadeCode("define(['exports'], 1);")).toBe(false);
    expect(isFacadeCode("define(['exports'], function ({ a }) {});")).toBe(false);
    expect(isFacadeCode("define(['exports'], function (exports) { return track(); });")).toBe(
      false,
    );
    expect(isFacadeCode("define(['exports']);")).toBe(false);
    expect(isFacadeCode("define(1, ['exports'], function (exports) {});")).toBe(false);
    expect(isFacadeCode("define(['exports'], (exports) => { exports.a = main.a; });")).toBe(true);
    expect(isFacadeCode("define(['exports'], (exports) => exports);")).toBe(false); // an expression body is not a facade body
    expect(isFacadeCode("other(['exports'], function (exports) {});")).toBe(false);
  });

  it('isFacadeCode round 19: SystemJS System.register(...) wrapping a facade', () => {
    const es5 = `System.register(['./main-C2NTlNLS.js', 'ext-a', 'ext-b', 'ext-c'], (function (exports) {
	'use strict';
	var _starExcludes = {
		__proto__: null,
		default: 1,
		a: 1,
		named: 1
	};
	return {
		setters: [function (module) {
			exports("a", module.a);
		}, function (module) {
			var setter = { __proto__: null };
			for (var name in module) {
				if (!_starExcludes[name]) setter[name] = module[name];
			}
			exports(setter);
		}, function (module) {
			exports("ns", module);
		}, function (module) {
			exports({ d: module.default, named: module.named });
		}],
		execute: (function () {



		})
	};
}));
//# sourceMappingURL=index.js.map
`;
    const es2015 = `System.register(['./main.js', 'ext-a'], (function (exports) {
	'use strict';
	const _starExcludes = { __proto__: null, default: 1 };
	return {
		setters: [module => {
			exports("a", module.a);
		}, module => {
			const setter = { __proto__: null };
			for (const name in module) {
				if (!_starExcludes[name]) setter[name] = module[name];
			}
			exports(setter);
		}],
		execute: (function () {})
	};
}));`;
    expect(isFacadeCode(es5)).toBe(true);
    expect(
      isFacadeCode(
        "System.register('id', [], (function (exports) { return { setters: [], execute: (function () {}) }; }));",
      ),
    ).toBe(true); // with a module id
    expect(isFacadeCode(es2015)).toBe(true);
    expect(
      isFacadeCode(
        es5
          .replace("'./main-C2NTlNLS.js', ", "'id', ['./main-C2NTlNLS.js'], ")
          .replace("'ext-a', 'ext-b', 'ext-c'], (", ''),
      ),
    ).toBe(false); // malformed head
    // anything that DOES something is not a facade
    expect(
      isFacadeCode(es5.replace('execute: (function () {', 'execute: (function () { track();')),
    ).toBe(false);
    expect(
      isFacadeCode(
        es5.replace('exports("a", module.a);', 'track(module); exports("a", module.a);'),
      ),
    ).toBe(false);
    expect(isFacadeCode(es5.replace("'use strict';", "'use strict'; track();"))).toBe(false);
    expect(isFacadeCode(es5.replace('return {', 'track(); return {'))).toBe(false);
    expect(isFacadeCode(es5.replace('setters: [', 'other: 1, setters: ['))).toBe(false);
    expect(isFacadeCode(es5.replace('execute:', 'run:'))).toBe(false);
    expect(isFacadeCode(es5.replace('setters:', 'listeners:'))).toBe(false);
    expect(isFacadeCode(es5.replace('(function () {\n\n\n\n\t\t})', '1'))).toBe(false);
    expect(isFacadeCode(es5.replace('function (exports)', 'function ({ exports })'))).toBe(false);
    // valid JavaScript with an application call in the prelude (the parse must succeed for the validator to judge it)
    const withProbe = es5.replace(
      'var _starExcludes = {',
      'var probe = track();\n\tvar _starExcludes = {',
    );
    expect(() => parse(withProbe, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
    expect(isFacadeCode(withProbe)).toBe(false);
    expect(
      isFacadeCode(
        'System.register([], (function (exports) { return { setters: [1], execute: (function () {}) }; }));',
      ),
    ).toBe(false);
    expect(isFacadeCode("System.register([], (function (exports) { exports('a', 1); }));")).toBe(
      false,
    ); // exports() outside a setter
    expect(isFacadeCode("exports('a', 1);")).toBe(false);
    expect(
      isFacadeCode(
        'System.other([], (function (exports) { return { setters: [], execute: (function () {}) }; }));',
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        'Other.register([], (function (exports) { return { setters: [], execute: (function () {}) }; }));',
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        'System.register([], (function (exports) { return { setters: [], execute: (function () {}) }; }));',
      ),
    ).toBe(true);
    expect(
      isFacadeCode('System.register([], (exports) => ({ setters: [], execute: () => {} }));'),
    ).toBe(false); // an expression body
    expect(
      isFacadeCode(
        'System.register(deps, (function (exports) { return { setters: [], execute: (function () {}) }; }));',
      ),
    ).toBe(false);
  });

  it('isFacadeCode round 20: AMD default-export mode (a trailing return of a reference)', () => {
    const amd = (body: string): string =>
      `define(['./main'], (function (main) { 'use strict'; ${body} }));`;
    expect(isFacadeCode(amd('return main;'))).toBe(true);
    expect(isFacadeCode(amd('return main.default;'))).toBe(true);
    expect(isFacadeCode(amd("return main['default'];"))).toBe(true);
    expect(isFacadeCode(amd('return;'))).toBe(false);
    expect(isFacadeCode(amd('return track();'))).toBe(false);
    expect(isFacadeCode(amd('return main.a.b.c;'))).toBe(true);
    expect(isFacadeCode(amd('return 1;'))).toBe(false);
    expect(isFacadeCode(amd('return main; track();'))).toBe(false); // the return is the LAST statement
    expect(isFacadeCode(amd('return main; return main;'))).toBe(false);
    const interopDefault = 'function _interopDefault(e){return e&&e.__esModule?e:{default:e}}';
    expect(
      isFacadeCode(amd(`${interopDefault}var x = _interopDefault(main); return x.default;`)),
    ).toBe(true);
    expect(isFacadeCode(amd('var x = _interopDefault(main); return x.default;'))).toBe(false); // undeclared helper
    expect(isFacadeCode(amd('return main[track()];'))).toBe(false);
    expect(isFacadeCode('return main;')).toBe(false); // not inside a wrapper (and a top-level return is not valid anyway)
  });

  it('isFacadeCode round 20: IIFE and UMD wrappers', () => {
    const body =
      "'use strict'; Object.defineProperty(exports, '__esModule', { value: true }); Object.keys(extA).forEach(function (k) { if (k !== 'default' && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, { enumerable: true, get: function () { return extA[k]; } }); }); exports.named = extC.named;";
    const iife = `var Lib = (function (exports, extA, extC) { ${body} return exports; })({}, A, C);`;
    expect(isFacadeCode(iife)).toBe(true);
    expect(isFacadeCode(`(function (exports, extA, extC) { ${body} })({}, A, C);`)).toBe(true);
    expect(
      isFacadeCode(
        `this.my = this.my || {};\nthis.my.Lib = (function (exports, extA, extC) { ${body} return exports; })({}, A, C);`,
      ),
    ).toBe(true);
    expect(isFacadeCode(iife.replace('return exports;', 'track(); return exports;'))).toBe(false);
    expect(isFacadeCode(iife.replace('({}, A, C)', '({}, track(), C)'))).toBe(false);
    expect(isFacadeCode(iife.replace('({}, A, C)', '({}, A, C, D)'))).toBe(false); // arity mismatch is not Rollup's
    expect(isFacadeCode(iife.replace('({}, A, C)', '({}, A)'))).toBe(false);
    expect(
      isFacadeCode(
        iife.replace('(function (exports, extA, extC)', '(function ({ exports }, extA, extC)'),
      ),
    ).toBe(false);
    expect(isFacadeCode(iife.replace('return exports;', 'return other;'))).toBe(true); // any pure reference may be returned
    expect(isFacadeCode(iife.replace('return exports;', 'return track;'))).toBe(true);
    expect(isFacadeCode(iife.replace('var Lib =', 'var Lib, Other ='))).toBe(false);
    expect(isFacadeCode(iife.replace('var Lib =', 'globalThis.Lib ='))).toBe(false);
    expect(isFacadeCode(`globalThis.my = globalThis.my || {};`)).toBe(false);
    expect(isFacadeCode(`this.my = other || {};`)).toBe(false);
    expect(isFacadeCode(`this.my = this.my || track();`)).toBe(false);
    expect(isFacadeCode(`this.my = this.other || {};`)).toBe(false);
    const umd = `(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports, require('ext-a'), require('ext-c')) :
  typeof define === 'function' && define.amd ? define(['exports', 'ext-a', 'ext-c'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.Lib = {}, global.A, global.C));
})(this, (function (exports, extA, extC) { ${body} }));`;
    expect(isFacadeCode(umd)).toBe(true);
    expect(
      isFacadeCode(
        umd.replace("factory(exports, require('ext-a')", "track(exports, require('ext-a')"),
      ),
    ).toBe(false);
    expect(isFacadeCode(umd.replace("require('ext-a')", 'require(dep)'))).toBe(false);
    expect(isFacadeCode(umd.replace('global.A, global.C', 'track(), global.C'))).toBe(false);
    expect(
      isFacadeCode(
        umd.replace("define(['exports', 'ext-a', 'ext-c'], factory)", "define(['exports'], other)"),
      ),
    ).toBe(false);
    expect(isFacadeCode(umd.replace('(this, (function', '(this, 1, (function'))).toBe(false);
    expect(isFacadeCode(umd.replace('exports.named = extC.named;', 'track();'))).toBe(false);
    expect(isFacadeCode(umd.replace('(global = typeof', '(globalThis.x = typeof'))).toBe(false);
    expect(
      isFacadeCode(umd.replace('factory(global.Lib = {}', 'factory(globalThis.Lib = {}')),
    ).toBe(false);
    expect(isFacadeCode(umd.replace('})(this,', '})(track(),'))).toBe(false);
    expect(isFacadeCode(umd.replace('(function (global, factory) {', '(function (global) {'))).toBe(
      false,
    );
    expect(
      isFacadeCode(
        umd.replace(
          /\(function \(global, factory\) \{[\s\S]*?\n\}\)\(this/,
          '(function (global, factory) { track(); })(this',
        ),
      ),
    ).toBe(false);
    expect(isFacadeCode(umd.replace('typeof exports', 'typeof track()'))).toBe(false);
  });

  it('isFacadeCode round 20: assignments inside callbacks are to local bindings or export targets only', () => {
    expect(isFacadeCode('Object.keys(dep).forEach(k => { globalThis.lastKey = k; });')).toBe(false);
    expect(isFacadeCode('Object.keys(dep).forEach(k => { [k] = dep; });')).toBe(false); // a pattern target
    expect(isFacadeCode('Object.keys(dep).forEach(k => { var [a] = dep; });')).toBe(false); // a pattern declaration
    expect(isFacadeCode('Object.keys(dep).forEach(k => { last = k; });')).toBe(false); // an unknown (global) binding
    expect(isFacadeCode('Object.keys(dep).forEach(k => { k = 1; });')).toBe(true); // a parameter
    expect(isFacadeCode('Object.keys(dep).forEach(k => { var acc = {}; acc[k] = dep[k]; });')).toBe(
      true,
    );
    expect(
      isFacadeCode('Object.keys(dep).forEach(k => { const acc = {}; acc.x.y = dep[k]; });'),
    ).toBe(true);
    expect(isFacadeCode('Object.keys(dep).forEach(k => { exports[k] = dep[k]; });')).toBe(true); // an export target
    expect(isFacadeCode('Object.keys(dep).forEach(k => { module.exports[k] = dep[k]; });')).toBe(
      true,
    );
    expect(isFacadeCode('Object.keys(dep).forEach(k => { exports[track()] = dep[k]; });')).toBe(
      false,
    );
    expect(isFacadeCode('Object.keys(dep).forEach(k => { x.y = dep[k]; });')).toBe(false);
    expect(
      isFacadeCode('Object.keys(dep).forEach(k => { for (const j in dep) { j = k; } });'),
    ).toBe(true);
    expect(isFacadeCode('Object.keys(dep).forEach(k => { for (j in dep) { j = k; } });')).toBe(
      false,
    ); // j is not declared
    expect(
      isFacadeCode(
        'function _interopX(e) { var n = Object.create(null); n.default = e; return n; }',
      ),
    ).toBe(true);
    expect(isFacadeCode('function _interopX(e) { n.default = e; return e; }')).toBe(false); // n is not a local
    expect(
      isFacadeCode('function _interopX(e) { return function (k) { e = k; return e; }; }'),
    ).toBe(false); // a function value is not pure
    expect(isFacadeCode("var o = require('x'); function _interopY(e) { o = e; return o; }")).toBe(
      false,
    ); // an OUTER binding
    expect(isFacadeCode('Object.keys(dep).forEach(function (k, j) { j = k; });')).toBe(true);
  });

  it('isFacadeCode round 20: computed export keys are checked', () => {
    expect(isFacadeCode('exports[track()] = main.a;')).toBe(false);
    expect(isFacadeCode("exports['a'] = main.a;")).toBe(true);
    expect(isFacadeCode('exports[k] = main.a;')).toBe(true);
    expect(isFacadeCode('module.exports[track()] = main.a;')).toBe(false);
    expect(isFacadeCode("module.exports['a'] = main.a;")).toBe(true);
    expect(isFacadeCode('exports.a[track()] = main.a;')).toBe(false);
    expect(isFacadeCode('exports[a][track()] = main.a;')).toBe(false);
    expect(isFacadeCode('exports[a][b] = main.a;')).toBe(true);
  });

  it('isFacadeCode round 20: SystemJS `exports` must be the factory callback, not a shadow', () => {
    const sys = (setter: string, param = 'exports'): string =>
      `System.register(['./m.js'], (function (${param}) { 'use strict'; return { setters: [${setter}], execute: (function () {}) }; }));`;
    expect(isFacadeCode(sys("function (module) { exports('a', module.a); }"))).toBe(true);
    expect(isFacadeCode(sys("function (module) { _e('a', module.a); }", '_e'))).toBe(true);
    expect(isFacadeCode(sys("function (module) { exports('a', module.a); }", '_e'))).toBe(false); // not the callback's name
    expect(isFacadeCode(sys("function (exports) { exports('a', 1); }"))).toBe(false); // the setter's own parameter
    expect(
      isFacadeCode(sys("function (module) { const exports = module.track; exports('a', 1); }")),
    ).toBe(false);
    expect(
      isFacadeCode(sys("function (module) { var exports = module.track; exports('a', 1); }")),
    ).toBe(false);
    expect(
      isFacadeCode(
        sys("function (module) { if (module) { var exports = module.track; } exports('a', 1); }"),
      ),
    ).toBe(false);
    expect(
      isFacadeCode(sys("function (module) { for (var exports in module) { } exports('a', 1); }")),
    ).toBe(false);
    expect(isFacadeCode(sys("function (module) { { const exports = 1; } exports('a', 1); }"))).toBe(
      false,
    );
    expect(
      isFacadeCode(
        sys("function (module) { if (module) exports('a', 1); else { const exports = 1; } }"),
      ),
    ).toBe(false);
    expect(
      isFacadeCode(sys('function (module) { for (const k in module) { const exports = k; } }')),
    ).toBe(false);
    expect(
      isFacadeCode(sys("function (module) { const other = module.a; exports('a', other); }")),
    ).toBe(true);
    expect(isFacadeCode(sys("function (module) { exports('a', track()); }"))).toBe(false); // every argument counts
    expect(isFacadeCode(sys("function (module) { exports(track(), 'a'); }"))).toBe(false);
    // the factory's own prelude may not shadow it either, and without a callback there is nothing to call
    expect(
      isFacadeCode(
        "System.register([], (function (exports) { var exports = track; return { setters: [function (m) { exports('a', 1); }], execute: (function () {}) }; }));",
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        "System.register([], (function () { return { setters: [function (m) { exports('a', 1); }], execute: (function () {}) }; }));",
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        'System.register([], (function () { return { setters: [function (m) { }], execute: (function () {}) }; }));',
      ),
    ).toBe(true);
    // a function as a setter's own parameter shadows nothing when it is not named like the callback
    expect(
      isFacadeCode(sys("function (m) { exports('a', m.a); }, function (n) { exports(n); }")),
    ).toBe(true);
  });

  it('isFacadeCode round 20: only the GENERATED registration statement is removed', () => {
    const real = (id: string): string =>
      `;!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._bugseeDebugIds=e._bugseeDebugIds||{},e._bugseeDebugIds[n]="${id}")}catch(e){}}();\n//# debugId=${id}`;
    const facade = "export{a}from'./m.js';\n";
    expect(isFacadeCode(`${facade}${real(ID_A)}`)).toBe(true); // the real CLI's stub
    expect(
      isFacadeCode(
        `${facade}\n!function(){var g=globalThis;g._bugseeDebugIds=g._bugseeDebugIds||{};g._bugseeDebugIds["x"]="${ID_A}"}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(true);
    expect(isFacadeCode(`${facade}console.log('_bugseeDebugIds');\n//# debugId=${ID_A}`)).toBe(
      false,
    );
    expect(isFacadeCode(`${facade}track('_bugseeDebugIds');\n//# debugId=${ID_A}`)).toBe(false);
    expect(
      isFacadeCode(
        `${facade}!function(){track(globalThis._bugseeDebugIds)}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        `${facade}!function(){globalThis._bugseeDebugIds = track()}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        `${facade}!function(a){var g=globalThis;g._bugseeDebugIds={}}(1);\n//# debugId=${ID_A}`,
      ),
    ).toBe(false); // an argument
    expect(
      isFacadeCode(
        `${facade}!function(a){var g=globalThis;g._bugseeDebugIds={}}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(false); // a parameter
    expect(
      isFacadeCode(
        `${facade}!function(){var g=globalThis;g._bugseeDebugIds={x:track()}}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(false);
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds={}}();\n//# debugId=${ID_A}`)).toBe(
      true,
    );
    expect(
      isFacadeCode(`${facade}!function(){var g=globalThis;g.other={}}();\n//# debugId=${ID_A}`),
    ).toBe(false); // does not mention the marker
    expect(
      isFacadeCode(
        `${facade}!function(){try{track()}catch(e){}g._bugseeDebugIds={}}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        `${facade}!function(){try{g._bugseeDebugIds={}}catch(e){track()}}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        `${facade}!function(){try{g._bugseeDebugIds={}}catch(e){}finally{track()}}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        `${facade}!function(){try{g._bugseeDebugIds={}}catch{}}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(true);
    expect(
      isFacadeCode(
        `${facade}!function(){var x=(new e.Error).stack;g._bugseeDebugIds=x}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(true);
    expect(
      isFacadeCode(
        `${facade}!function(){var x=new track();g._bugseeDebugIds=x}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        `${facade}!function(){var x=(new e.Error(1)).stack;g._bugseeDebugIds=x}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        `${facade}!function(){var x=a?b:c;g._bugseeDebugIds={}}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(true);
    expect(
      isFacadeCode(
        `${facade}!function(){var x={a:1};g._bugseeDebugIds={}}();\n//# debugId=${ID_A}`,
      ),
    ).toBe(false); // only `{}`
    expect(
      isFacadeCode(`${facade}void function(){g._bugseeDebugIds={}}();\n//# debugId=${ID_A}`),
    ).toBe(false); // not the generated `!`
    expect(
      isFacadeCode(`${facade}!function(){x:1;g._bugseeDebugIds={}}();\n//# debugId=${ID_A}`),
    ).toBe(false);
    expect(
      isFacadeCode(`${facade}!function(){var [a]=b;g._bugseeDebugIds={}}();\n//# debugId=${ID_A}`),
    ).toBe(false);
    expect(
      isFacadeCode(`${facade}!(function(){g._bugseeDebugIds={}}());\n//# debugId=${ID_A}`),
    ).toBe(true);
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds+=1}();\n//# debugId=${ID_A}`)).toBe(
      false,
    );
    expect(isFacadeCode(`${facade}!function(){(a,b)}();\n//# debugId=${ID_A}`)).toBe(false); // no marker
    expect(
      isFacadeCode(`${facade}!function(){g._bugseeDebugIds=(1,2)}();\n//# debugId=${ID_A}`),
    ).toBe(true);
    expect(
      isFacadeCode(`${facade}!function(){g._bugseeDebugIds=typeof g}();\n//# debugId=${ID_A}`),
    ).toBe(true);
    expect(
      isFacadeCode(`${facade}!function(){g._bugseeDebugIds=delete g.x}();\n//# debugId=${ID_A}`),
    ).toBe(false);
    expect(
      isFacadeCode(`${facade}!function(){g._bugseeDebugIds=a[b]}();\n//# debugId=${ID_A}`),
    ).toBe(true);
    expect(
      isFacadeCode(`${facade}!function(){g._bugseeDebugIds=a[track()]}();\n//# debugId=${ID_A}`),
    ).toBe(false);
    expect(
      isFacadeCode(`${facade}!function(){g._bugseeDebugIds=1+2}();\n//# debugId=${ID_A}`),
    ).toBe(true);
    expect(
      isFacadeCode(`${facade}!function(){g._bugseeDebugIds=a&&b}();\n//# debugId=${ID_A}`),
    ).toBe(true);
  });

  it('isFacadeCode round 20b: near misses of every whitelisted shape', () => {
    const has = (callee: string): string =>
      `${callee}(a, b) && Object.defineProperty(exports, 'x', {});`;
    expect(isFacadeCode(has('Object.prototype.hasOwnProperty.call'))).toBe(true);
    expect(
      isFacadeCode(
        "Object.prototype.hasOwnProperty.call(a, track()) && Object.defineProperty(exports, 'x', {});",
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        "Object.prototype.hasOwnProperty.call(track(), b) && Object.defineProperty(exports, 'x', {});",
      ),
    ).toBe(false);
    expect(isFacadeCode(has('Object.prototype.hasOwnProperty.apply'))).toBe(false);
    expect(isFacadeCode(has('Object.prototype.hasOwn.call'))).toBe(false);
    expect(isFacadeCode(has('Other.prototype.hasOwnProperty.call'))).toBe(false);
    expect(isFacadeCode(has('Object.proto.hasOwnProperty.call'))).toBe(false);
    expect(isFacadeCode(has('Object.prototype.hasOwnProperty'))).toBe(false);
    expect(isFacadeCode(has('prototype.hasOwnProperty.call'))).toBe(false);
    expect(isFacadeCode(has('x.hasOwnProperty.call'))).toBe(false);
    expect(isFacadeCode(has('hasOwnProperty.call'))).toBe(false);
    expect(
      isFacadeCode(has('Object.prototype.hasOwnProperty.call'.replace('Object.', '(a, b).'))),
    ).toBe(false);
    // every argument counts, not just one of them
    expect(isFacadeCode('Object.keys(x, track()).forEach(() => {});')).toBe(false);
    expect(isFacadeCode('_interopDefault(a, track());')).toBe(false);
    expect(isFacadeCode("Object.defineProperty(exports, 'a', track());")).toBe(false);
    expect(isFacadeCode('Object.freeze(a, track());')).toBe(false);
    expect(isFacadeCode('Object.freeze(a, b);')).toBe(true);
    expect(isFacadeCode('other.keys(x);')).toBe(false);
    expect(isFacadeCode('Other.keys(x);')).toBe(false);
    expect(isFacadeCode('Object.assign(x);')).toBe(false);
    expect(isFacadeCode('exports.a = ok ? track() : b;')).toBe(false);
    expect(isFacadeCode('exports.a = ok ? b : track();')).toBe(false);
    expect(isFacadeCode('exports.a = track() ? a : b;')).toBe(false);
    expect(isFacadeCode('exports.a = ok ? a : b;')).toBe(true);
    expect(isFacadeCode('function _interopX(e) { var a = e, b = track(); return a; }')).toBe(false);
    expect(isFacadeCode('function _interopX(e) { var a = e, b = e; return a; }')).toBe(true);
    expect(isFacadeCode('define([], function (a, { b }) {});')).toBe(false);
    expect(isFacadeCode('define([], function (a, b) {});')).toBe(true);
    expect(isFacadeCode("define(['a', b], function () {});")).toBe(false);
    expect(isFacadeCode("define(['a', 'b'], function () {});")).toBe(true);
    expect(isFacadeCode('(function (exports) { })(this);')).toBe(true);
    expect(isFacadeCode('(function (exports) { })({});')).toBe(true);
    expect(isFacadeCode('(function (exports) { })(window);')).toBe(true);
    expect(isFacadeCode('(function (exports) { })(track());')).toBe(false);
    expect(isFacadeCode('(function (exports) { })({ a: track() });')).toBe(false);
    expect(
      isFacadeCode('(function (global, factory) { typeof exports; })(this, function () {});'),
    ).toBe(false);
    const umdHead = (deps: string): string =>
      `(function (global, factory) { typeof define === 'function' && define.amd ? define(${deps}, factory) : factory(global); })(this, (function (exports) { }));`;
    expect(isFacadeCode(umdHead("['a', 'b']"))).toBe(true);
    expect(isFacadeCode(umdHead("['a', b]"))).toBe(false);
    expect(isFacadeCode(umdHead('[]'))).toBe(true);
    expect(isFacadeCode(umdHead('a'))).toBe(false);
    expect(isFacadeCode(umdHead("['a'], 1"))).toBe(false);
    const sysWith = (head: string, tail = ''): string =>
      `System.register(${head}, ${tail}(function (exports) { return { setters: [], execute: (function () {}) }; }));`;
    expect(isFacadeCode(sysWith('[]'))).toBe(true);
    expect(isFacadeCode(sysWith('[1]'))).toBe(false);
    expect(isFacadeCode(sysWith("['a', b]"))).toBe(false);
    expect(isFacadeCode(sysWith('1'))).toBe(false);
    expect(isFacadeCode('System.register([]);')).toBe(false);
    expect(isFacadeCode('System.register([], 1);')).toBe(false);
    expect(
      isFacadeCode('System.register([], (a) => { return { setters: [], execute: () => {} }; });'),
    ).toBe(true);
    expect(
      isFacadeCode(
        'System.register([], (function (exports) { var a = {}, b = track(); return { setters: [], execute: (function () {}) }; }));',
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        'System.register([], (function (exports) { var a = {}, b = {}; return { setters: [], execute: (function () {}) }; }));',
      ),
    ).toBe(true);
    expect(
      isFacadeCode(
        'System.register([], (function (exports) { return { setters: 1, execute: (function () {}) }; }));',
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        'System.register([], (function (exports) { return { setters: [], other: (function () {}) }; }));',
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        'System.register([], (function (exports) { return { other: [], execute: (function () {}) }; }));',
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        'System.register([], (function (exports) { return { setters: [], execute: 1 }; }));',
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        'System.register([], (function (exports) { return { execute: (function () {}), setters: [] }; }));',
      ),
    ).toBe(true);
    // a stub's every statement and every operand must be plain
    const facade = "export{a}from'./m.js';\n";
    const tail = `\n//# debugId=${ID_A}`;
    expect(
      isFacadeCode(`${facade}!function(){var a=1,b=track();g._bugseeDebugIds={}}();${tail}`),
    ).toBe(false);
    expect(isFacadeCode(`${facade}!function(){var a=1,b=2;g._bugseeDebugIds={}}();${tail}`)).toBe(
      true,
    );
    expect(
      isFacadeCode(`${facade}!function(){try{g._bugseeDebugIds={};track()}catch(e){}}();${tail}`),
    ).toBe(false);
    expect(
      isFacadeCode(`${facade}!function(){try{g._bugseeDebugIds={};h=1}catch(e){}}();${tail}`),
    ).toBe(true);
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds=a&&track()}();${tail}`)).toBe(
      false,
    );
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds=track()&&a}();${tail}`)).toBe(
      false,
    );
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds=a?track():b}();${tail}`)).toBe(
      false,
    );
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds=a?b:track()}();${tail}`)).toBe(
      false,
    );
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds=track()?a:b}();${tail}`)).toBe(
      false,
    );
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds=(a,track())}();${tail}`)).toBe(
      false,
    );
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds=(track(),a)}();${tail}`)).toBe(
      false,
    );
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds=a?b:c}();${tail}`)).toBe(true);
    expect(isFacadeCode(`${facade}!function(){track()._bugseeDebugIds={}}();${tail}`)).toBe(false);
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds=(a,b)}();${tail}`)).toBe(true);
    // the debugId comment must be a LINE comment AFTER the statement
    expect(
      isFacadeCode(`${facade}!function(){g._bugseeDebugIds={}}();\n/*# debugId=${ID_A}*/`),
    ).toBe(false);
    expect(isFacadeCode(`//# debugId=${ID_A}\n${facade}!function(){g._bugseeDebugIds={}}();`)).toBe(
      false,
    );
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds={}}();\n// debugId=${ID_A}`)).toBe(
      false,
    );
    expect(isFacadeCode(`${facade}!function(){g._bugseeDebugIds={}}();//# debugId=${ID_A}`)).toBe(
      true,
    ); // same line
  });

  it("isFacadeCode round 21: terser's minified output (sequences, renamed bindings, renamed helpers)", () => {
    const cjs = `"use strict";var e=require("ext-a"),r=require("ext-b"),t=require("ext-c");function n(e){var r=Object.create(null);return e&&Object.keys(e).forEach(function(t){if("default"!==t){var n=Object.getOwnPropertyDescriptor(e,t);Object.defineProperty(r,t,n.get?n:{enumerable:!0,get:function(){return e[t]}})}}),r.default=e,Object.freeze(r)}var o=n(r);exports.ns=o,exports.d=t,Object.defineProperty(exports,"named",{enumerable:!0,get:function(){return t.named}}),Object.keys(e).forEach(function(r){"default"===r||Object.prototype.hasOwnProperty.call(exports,r)||Object.defineProperty(exports,r,{enumerable:!0,get:function(){return e[r]}})});`;
    expect(isFacadeCode(cjs)).toBe(true);
    expect(
      isFacadeCode(
        '"use strict";var r=require("./utils/a.js"),s=require("./utils/b.js");exports.a=r.a,exports.b=s.b;',
      ),
    ).toBe(true);
    expect(isFacadeCode('exports.a=r.a,track();')).toBe(false);
    expect(isFacadeCode('exports.a=r.a,globalThis.x=1;')).toBe(false);
    expect(isFacadeCode('a,b;')).toBe(false); // a sequence of references does nothing a facade needs
    expect(isFacadeCode('exports.a=r.a,b;')).toBe(false);
    expect(isFacadeCode(cjs.replace('Object.freeze(r)', 'track(r)'))).toBe(false);
    expect(isFacadeCode(cjs.replace('r.default=e', 'globalThis.default=e'))).toBe(false);
    // a renamed helper is still a helper only if it is interop-shaped, and only the declared names are callable
    expect(
      isFacadeCode(
        cjs.replace('function n(e){var r=Object.create(null);', 'function n(e){var r=track();'),
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        'function n(e){return e.__esModule?e:{default:e}}var o=n(require("x"));exports.a=o;',
      ),
    ).toBe(true);
    expect(isFacadeCode('function n(e){return e}var o=n(require("x"));exports.a=o;')).toBe(false);
    expect(isFacadeCode('var o=m(require("x"));exports.a=o;')).toBe(false);
    expect(
      isFacadeCode(
        'const e=(e=>e&&e.__esModule?e:{default:e})(require("ext-d"));module.exports=e.default;',
      ),
    ).toBe(true);
    expect(isFacadeCode('const e=(e=>e)(require("ext-d"));module.exports=e.default;')).toBe(false);
    expect(
      isFacadeCode('const e=(e=>e&&e.__esModule?e:{default:e})(require("ext-d"),track());'),
    ).toBe(false);
    expect(isFacadeCode('const e=((e,f)=>e&&e.__esModule?e:{default:e})(require("ext-d"));')).toBe(
      false,
    ); // arity
    expect(isFacadeCode('const e=(e=>e&&e.__esModule?e:track(e))(require("ext-d"));')).toBe(false);
    // AMD / IIFE / UMD with the exports binding renamed
    const amd =
      'define(["exports","ext-a"],function(e,t){"use strict";e.a=t.a,e.b=t.b,Object.keys(t).forEach(function(r){"default"===r||Object.prototype.hasOwnProperty.call(e,r)||Object.defineProperty(e,r,{enumerable:!0,get:function(){return t[r]}})})});';
    expect(isFacadeCode(amd)).toBe(true);
    expect(isFacadeCode(amd.replace('["exports","ext-a"]', '["ext-a"]'))).toBe(false); // the first parameter is then a dependency
    expect(isFacadeCode(amd.replace('["exports","ext-a"]', '["ext-a","exports"]'))).toBe(false);
    expect(isFacadeCode(amd.replace('e.a=t.a,', 't.a=e.a,'))).toBe(false); // a write to the dependency
    expect(isFacadeCode(amd.replace('e.a=t.a,', 'track(),e.a=t.a,'))).toBe(false);
    expect(
      isFacadeCode(
        'define(["ext-d"],function(e){"use strict";function t(e){return e&&e.__esModule?e:{default:e}}return t(e).default});',
      ),
    ).toBe(true);
    expect(isFacadeCode('define(["ext-d"],function(e){"use strict";return e.default});')).toBe(
      true,
    );
    expect(
      isFacadeCode('define(["ext-d"],function(e){"use strict";return track(e).default});'),
    ).toBe(false);
    expect(isFacadeCode('define(["ext-d"],function(e){"use strict";return track()});')).toBe(false);
    expect(isFacadeCode('define(["ext-d"],function(e){"use strict";return e.a,e});')).toBe(false); // a bare reference in a sequence
    const iife = 'var Lib=function(e,t){"use strict";return e.a=t.a,e.b=t.b,e}({},A);';
    expect(isFacadeCode(iife)).toBe(true);
    expect(isFacadeCode('!function(e,t){e.a=t.a}({},A);')).toBe(true);
    expect(isFacadeCode('!function(e,t){e.a=t.a}(x,A);')).toBe(false); // the first argument is not a fresh object
    expect(isFacadeCode(iife.replace('({},A)', '(track(),A)'))).toBe(false);
    expect(isFacadeCode(iife.replace('return e.a=t.a,e.b=t.b,e', 'return e.a=t.a,track(),e'))).toBe(
      false,
    );
    expect(isFacadeCode(iife.replace('e.a=t.a', 't.a=e.a'))).toBe(false);
    expect(isFacadeCode('void function(e,t){e.a=t.a}({},A);')).toBe(true);
    expect(isFacadeCode('typeof function(e,t){e.a=t.a}({},A);')).toBe(false);
    expect(
      isFacadeCode('this.my=this.my||{},this.my.Lib=function(e,t){return e.a=t.a,e}({},A);'),
    ).toBe(true);
    expect(
      isFacadeCode('this.my=this.my||{},track(),this.my.Lib=function(e,t){return e}({},A);'),
    ).toBe(false);
    expect(isFacadeCode('this.my=this.my||{},this.other=1;')).toBe(false);
    expect(isFacadeCode('!function(e,t){e.a=t.a}({},A),track();')).toBe(false);
  });

  it('isFacadeCode round 21: UMD default mode, IIFE extend, noConflict, default-only globals', () => {
    const umdDefault = `(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory(require('ext-a')) :
  typeof define === 'function' && define.amd ? define(['ext-a'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.Lib = factory(global.A));
})(this, (function (extA) { 'use strict'; return extA; }));`;
    expect(isFacadeCode(umdDefault)).toBe(true);
    expect(
      isFacadeCode(umdDefault.replace('module.exports = factory', 'globalThis.x = factory')),
    ).toBe(false);
    expect(
      isFacadeCode(
        umdDefault.replace('global.Lib = factory(global.A)', 'globalThis.Lib = factory(global.A)'),
      ),
    ).toBe(false);
    expect(isFacadeCode(umdDefault.replace('return extA;', 'return track(extA);'))).toBe(false);
    expect(
      isFacadeCode(
        '!function(e,t){"object"==typeof exports&&"undefined"!=typeof module?module.exports=t(require("ext-a")):"function"==typeof define&&define.amd?define(["ext-a"],t):(e="undefined"!=typeof globalThis?globalThis:e||self).Lib=t(e.A)}(this,function(e){"use strict";return e});',
      ),
    ).toBe(true);
    expect(
      isFacadeCode(
        '!function(e,t){"object"==typeof exports?module.exports=t(require("ext-a")):(e=globalThis).Lib=t(e.A)}(this,function(e){return track(e)});',
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        '!function(e,t){"object"==typeof exports?module.exports=t(require("ext-a")):(x=globalThis).Lib=t(e.A)}(this,function(e){return e});',
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        '!function(e,t){"object"==typeof exports?module.exports=t(require("ext-a")):(e=track()).Lib=t(e.A)}(this,function(e){return e});',
      ),
    ).toBe(false);
    const extend = `(function (exports, extA, extC) { 'use strict'; exports.named = extC.named; })(this.Lib = this.Lib || {}, A, C);`;
    expect(isFacadeCode(extend)).toBe(true);
    expect(
      isFacadeCode(
        `this.my = this.my || {};\n${extend.replace('this.Lib = this.Lib', 'this.my.Lib = this.my.Lib')}`,
      ),
    ).toBe(true);
    expect(
      isFacadeCode(extend.replace('this.Lib = this.Lib || {}', 'this.Lib = this.Other || {}')),
    ).toBe(false);
    expect(
      isFacadeCode(extend.replace('this.Lib = this.Lib || {}', 'this.Lib = this.Lib || track()')),
    ).toBe(false);
    expect(
      isFacadeCode(
        extend.replace('this.Lib = this.Lib || {}', 'globalThis.Lib = globalThis.Lib || {}'),
      ),
    ).toBe(false);
    expect(isFacadeCode('var Lib = A;')).toBe(true);
    expect(isFacadeCode('this.Lib = A;')).toBe(true);
    expect(isFacadeCode('this.Lib = 1;')).toBe(false);
    expect(isFacadeCode('this.Lib = track();')).toBe(false);
    expect(isFacadeCode('var Lib = 1;')).toBe(false);
    const noConflict = `(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports, require('ext-a')) :
  typeof define === 'function' && define.amd ? define(['exports', 'ext-a'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, (function () {
    var current = global.Lib;
    var exports = global.Lib = {};
    factory(exports, global.A);
    exports.noConflict = function () { global.Lib = current; return exports; };
  })());
})(this, (function (exports, extA) { 'use strict'; exports.a = extA.a; }));`;
    expect(isFacadeCode(noConflict)).toBe(true);
    expect(
      isFacadeCode(
        noConflict.replace(
          'exports.noConflict = function () {',
          'exports.noConflict = function (x) {',
        ),
      ),
    ).toBe(false); // a parameter
    expect(
      isFacadeCode(
        noConflict.replace(
          /exports\.noConflict = function \(\) \{[^}]*\};/,
          'exports.noConflict = 1;',
        ),
      ),
    ).toBe(false); // not a function
    expect(
      isFacadeCode(
        noConflict.replace(
          'exports.noConflict = function () { global.Lib = current; return exports; };',
          'exports.noConflict = function () { track(); return exports; };',
        ),
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        noConflict.replace('global.Lib = current; return exports;', 'global.Lib = current;'),
      ),
    ).toBe(false); // no return
    expect(
      isFacadeCode(noConflict.replace('global.Lib = current;', 'globalThis.Lib = current;')),
    ).toBe(false);
    expect(isFacadeCode(noConflict.replace('global.Lib = current;', 'global.Lib = 1;'))).toBe(
      false,
    );
    expect(isFacadeCode(noConflict.replace('return exports; };', 'return other; };'))).toBe(false);
    expect(
      isFacadeCode(
        noConflict.replace('exports.noConflict = function ()', 'other.noConflict = function ()'),
      ),
    ).toBe(false);
    expect(
      isFacadeCode(noConflict.replace('factory(exports, global.A);', 'factory(exports, track());')),
    ).toBe(false);
    expect(
      isFacadeCode(noConflict.replace('factory(exports, global.A);', 'other(exports, global.A);')),
    ).toBe(false);
    expect(
      isFacadeCode(noConflict.replace('var current = global.Lib;', 'var current = track();')),
    ).toBe(false);
    expect(isFacadeCode(noConflict.replace('var current = global.Lib;', 'track();'))).toBe(false);
    expect(
      isFacadeCode(
        noConflict.replace('(function () {\n    var current', '(function (x) {\n    var current'),
      ),
    ).toBe(false);
    expect(isFacadeCode(noConflict.replace('})());', '})(1));'))).toBe(false);
    // minified es2015 noConflict
    expect(
      isFacadeCode(
        '!function(e,t){"object"==typeof exports&&"undefined"!=typeof module?t(exports,require("ext-a")):"function"==typeof define&&define.amd?define(["exports","ext-a"],t):(e="undefined"!=typeof globalThis?globalThis:e||self,(()=>{const n=e.Lib,o=e.Lib={};t(o,e.A),o.noConflict=()=>(e.Lib=n,o)})())}(this,function(e,t){"use strict";e.a=t.a});',
      ),
    ).toBe(true);
    expect(
      isFacadeCode(
        '!function(e,t){"object"==typeof exports?t(exports):(e=globalThis,(()=>{const n=e.Lib,o=e.Lib={};t(o),o.noConflict=()=>(track(),n,o)})())}(this,function(e){"use strict";});',
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        '!function(e,t){"object"==typeof exports?t(exports):(e=globalThis,(()=>{const n=e.Lib,o=e.Lib={};t(o),o.noConflict=()=>o})())}(this,function(e){"use strict";});',
      ),
    ).toBe(false); // restores nothing
    expect(
      isFacadeCode(
        '!function(e,t){"object"==typeof exports?t(exports):(e=globalThis,(()=>{const n=e.Lib,o=e.Lib={};t(o),o.noConflict=()=>{}})())}(this,function(e){"use strict";});',
      ),
    ).toBe(false);
  });

  it('isFacadeCode round 22: helpers are lexical bindings, not names', () => {
    const helper = 'function n(e){return e&&e.__esModule?e:{default:e}}';
    // the call resolves to a declared, pure helper in scope
    expect(isFacadeCode(`${helper}exports.x=n(require('a'));`)).toBe(true);
    expect(
      isFacadeCode(
        `var n=function(e){return e&&e.__esModule?e:{default:e}};exports.x=n(require('a'));`,
      ),
    ).toBe(true);
    // an `_interop*` NAME alone approves nothing: the helper has to be declared
    expect(isFacadeCode("exports.x=_interopDefault(require('a'));")).toBe(false);
    expect(isFacadeCode("define(['exports','./dep'],function(e,t){e.x=_interopDefault(t)});")).toBe(
      false,
    );
    expect(
      isFacadeCode(
        "function _interopDefault(e){return e&&e.__esModule?e:{default:e}}exports.x=_interopDefault(require('a'));",
      ),
    ).toBe(true);
    // a second declaration of the name (the later one wins at runtime) is not a helper
    expect(
      isFacadeCode(
        `var _interopDefault=function(e){return e&&e.__esModule?e:{default:e}};var _interopDefault=function(){globalThis.fetch('x')};exports.x=_interopDefault(a);`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        `${helper}${helper.replace('return e&&e.__esModule?e:{default:e}', 'globalThis.fetch("x")')}exports.x=n(1);`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        `define(["exports","./dep"],function(e,t){${helper}function n(){globalThis.fetch("x")}e.x=n(t)});`,
      ),
    ).toBe(false);
    expect(isFacadeCode(`${helper}var n=2;exports.x=n(1);`)).toBe(false);
    // a parameter shadows a helper of an outer scope
    expect(isFacadeCode(`${helper}define(["exports","./dep"],function(e,n){e.x=n()});`)).toBe(
      false,
    );
    expect(isFacadeCode(`${helper}define(["exports","./dep"],function(e,t){e.x=n(t)});`)).toBe(
      true,
    );
    expect(isFacadeCode(`${helper}Object.keys(x).forEach(function(n){n()});`)).toBe(false);
    // a function-local name shadows it too
    expect(
      isFacadeCode(
        `${helper}function _interopX(e){var n=e.track;return n(e)}exports.a=_interopX(1);`,
      ),
    ).toBe(false);
    // an import of the same name is not the helper
    expect(isFacadeCode(`import { n } from './app.js';${helper}`)).toBe(false);
    expect(
      isFacadeCode(
        "import { n } from './app.js';define([],function(){function n(x){return x.__esModule}});n(x);",
      ),
    ).toBe(false);
    expect(isFacadeCode("import n from './app.js';exports.x=n(1);")).toBe(false);
    // a helper of ONE factory is not a helper of the code outside it, nor of another factory
    expect(
      isFacadeCode(
        `define([],function(){${helper}exports.a=n(1)});define([],function(){exports.b=n(1)});`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(`!function(e){${helper}e.a=n(1)}({});!function(e,t){e.b=t()}({},Dep);`),
    ).toBe(false);
    expect(isFacadeCode(`!function(e){${helper}e.a=n(1)}({});!function(e){e.b=n(1)}({});`)).toBe(
      false,
    );
    expect(isFacadeCode(`define([],function(){${helper}exports.a=n(1)});n(1);`)).toBe(false);
    expect(isFacadeCode(`define(["exports"],function(e){${helper}e.a=n(1)});`)).toBe(true);
    // the interop-shaped test also covers 'compat' (a `'default' in e` check, no __esModule)
    expect(
      isFacadeCode(
        'function u(e){return e&&"object"==typeof e&&"default"in e?e:{default:e}}var o=u(require("ext-c"));exports.c=o;',
      ),
    ).toBe(true);
    expect(
      isFacadeCode(
        "function u(e){return e&&'object'==typeof e&&'default' in e?e:{default:e}}var o=u(require('x'));",
      ),
    ).toBe(true);
    expect(
      isFacadeCode(
        'function u(e){return e&&"object"==typeof e?e:{default:e}}var o=u(require("x"));',
      ),
    ).toBe(false); // not shaped like interop
    // the helper must be pure in ITS body, wherever it is declared
    expect(isFacadeCode('function n(e){return track(e.__esModule)}var o=n(require("x"));')).toBe(
      false,
    );
  });

  it('isFacadeCode round 22: SystemJS loop targets, noConflict keys, registration receivers', () => {
    const sys = (setter: string): string =>
      `System.register([], (function (exports) { return { setters: [${setter}], execute: (function () {}) }; }));`;
    expect(isFacadeCode(sys("function (m) { for (exports in m) {} exports('a', m.a); }"))).toBe(
      false,
    ); // writes the callback
    expect(isFacadeCode(sys('function (m) { for (k in m) {} }'))).toBe(false); // an undeclared target
    expect(isFacadeCode(sys("function (m) { var k; for (k in m) {} exports('a', m.a); }"))).toBe(
      true,
    );
    expect(
      isFacadeCode(sys("function (m) { for (const exports in m) {} exports('a', m.a); }")),
    ).toBe(true);
    expect(
      isFacadeCode(
        sys("function (m) { var exports2; for (exports2 in m) { exports('a', m[exports2]); } }"),
      ),
    ).toBe(true);
    const nc = (target: string): string =>
      `(function (global, factory) { typeof exports === 'object' ? factory(exports) : (global = globalThis, (function () { var current = global.Lib; var exports = global.Lib = {}; factory(exports); ${target} = function () { global.Lib = current; return exports; }; })()); })(this, (function (exports) {}));`;
    expect(isFacadeCode(nc('exports.noConflict'))).toBe(true);
    expect(isFacadeCode(nc("exports['noConflict']"))).toBe(true);
    expect(isFacadeCode(nc('exports[track()]'))).toBe(false);
    expect(isFacadeCode(nc('exports.other'))).toBe(false);
    expect(isFacadeCode(nc("exports['other']"))).toBe(false);
    expect(isFacadeCode(nc('exports[noConflict]'))).toBe(false); // an identifier key is a variable, not the property
    expect(isFacadeCode(nc('exports'))).toBe(false);
    const facade = "export{a}from'./m.js';\n";
    const tail = `\n//# debugId=${ID_A}`;
    expect(
      isFacadeCode(
        `${facade}!function(){var x=new (track()).Error();g._bugseeDebugIds={}}();${tail}`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(`${facade}!function(){var x=new e.Error;g._bugseeDebugIds={}}();${tail}`),
    ).toBe(true);
    expect(
      isFacadeCode(`${facade}!function(){var x=new (a?b:c).Error;g._bugseeDebugIds={}}();${tail}`),
    ).toBe(true);
    expect(
      isFacadeCode(
        `${facade}!function(){var x=new e[track()].Error;g._bugseeDebugIds={}}();${tail}`,
      ),
    ).toBe(false);
    expect(
      isFacadeCode(`${facade}!function(){var x=new Error;g._bugseeDebugIds={}}();${tail}`),
    ).toBe(false); // the generated form has a receiver
  });

  it('isFacadeCode round 21b: near misses of the wrapper readers', () => {
    // what a wrapper may return after its export writes: a reference chain
    const ret = (value: string): string => `var Lib=function(e,t){return e.a=t.a,${value}}({},A);`;
    expect(isFacadeCode(ret('t.b'))).toBe(true);
    expect(isFacadeCode(ret('t.b.c'))).toBe(true);
    expect(isFacadeCode(ret('t["b"]'))).toBe(true);
    expect(isFacadeCode(ret('1'))).toBe(false);
    expect(isFacadeCode(ret('track().x'))).toBe(false); // a member of a call result is not a reference chain
    expect(isFacadeCode(ret('t[track()]'))).toBe(false);
    expect(isFacadeCode(ret('t.b()'))).toBe(false);
    expect(isFacadeCode(ret('"s"'))).toBe(false);
    // `this` namespace statements and operators
    expect(isFacadeCode('this.my += this.my || {};')).toBe(false);
    expect(isFacadeCode('(function (exports) {})(this.Lib += this.Lib || {});')).toBe(false); // an IIFE argument
    expect(isFacadeCode('(function (exports) {})(this.Lib = this.Lib || {});')).toBe(true);
    expect(isFacadeCode('this.my ||= {};')).toBe(false);
    expect(isFacadeCode('this.my = this.my || {};')).toBe(true);
    expect(isFacadeCode('this.my;')).toBe(false);
    expect(isFacadeCode('this.Lib += A;')).toBe(false);
    expect(isFacadeCode('this.Lib = this.Lib || {};')).toBe(true);
    expect(isFacadeCode('track(this.my || {});')).toBe(false);
    // the UMD wrapper's own shape
    const body = 'typeof exports === "object" ? factory(exports) : factory(global);';
    const umd = (head: string, preamble = body, args = 'this, function (exports) {}'): string =>
      `(function (${head}) { ${preamble} })(${args});`;
    expect(isFacadeCode(umd('global, factory'))).toBe(true);
    expect(isFacadeCode(umd('global, factory, extra'))).toBe(false);
    expect(isFacadeCode(umd('global'))).toBe(false);
    expect(isFacadeCode(umd('{ global }, factory'))).toBe(false);
    expect(isFacadeCode(umd('global, { factory }'))).toBe(false);
    expect(isFacadeCode(umd('global, factory', `${body} ${body}`))).toBe(false); // one statement
    expect(isFacadeCode(umd('global, factory', ''))).toBe(false);
    expect(isFacadeCode(umd('global, factory', 'var x = 1;'))).toBe(false);
    // noConflict restorers
    const nc = (restorer: string): string =>
      `(function (global, factory) { typeof exports === 'object' ? factory(exports) : (global = globalThis, (function () { var current = global.Lib; var exports = global.Lib = {}; factory(exports); exports.noConflict = ${restorer}; })()); })(this, (function (exports) {}));`;
    expect(isFacadeCode(nc('function () { global.Lib = current; return exports; }'))).toBe(true);
    expect(
      isFacadeCode(
        nc('function () { global.Lib = current; global.Other = current; return exports; }'),
      ),
    ).toBe(true);
    expect(isFacadeCode(nc('function () { global.Lib = current; track(); return exports; }'))).toBe(
      false,
    );
    expect(
      isFacadeCode(nc('function () { global.Lib = current; global.Other = 1; return exports; }')),
    ).toBe(false);
    expect(isFacadeCode(nc('function () { track(); global.Lib = current; return exports; }'))).toBe(
      false,
    );
    expect(isFacadeCode(nc('function () { global.Lib += current; return exports; }'))).toBe(false);
    expect(isFacadeCode(nc('function () { global.Lib = current; return track; }'))).toBe(false);
    expect(isFacadeCode(nc('() => (global.Lib = current, exports)'))).toBe(true);
    expect(isFacadeCode(nc('() => (global.Lib = current, track())'))).toBe(false);
    expect(isFacadeCode(nc('() => (track(), exports)'))).toBe(false);
    expect(isFacadeCode(nc('1'))).toBe(false);
    expect(isFacadeCode(nc('function (x) { global.Lib = current; return exports; }'))).toBe(false);
    expect(
      isFacadeCode(
        "(function (global, factory) { typeof exports === 'object' ? factory(exports) : (global = globalThis, (function () { var current = global.Lib; var exports = global.Lib = {}; factory(exports); exports.noConflict += function () { global.Lib = current; return exports; }; })()); })(this, (function (exports) {}));",
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        "(function (global, factory) { typeof exports === 'object' ? factory(exports) : (global = globalThis, (function () { var current = global.Lib; var exports = global.Lib = {}; factory(exports); exports.noConflict; })()); })(this, (function (exports) {}));",
      ),
    ).toBe(false);
    // System: an extra property, or the wrong ones
    const sysProps = (props: string): string =>
      `System.register([], (function (exports) { return { ${props} }; }));`;
    expect(isFacadeCode(sysProps('setters: [], execute: (function () {})'))).toBe(true);
    expect(isFacadeCode(sysProps('setters: [], execute: (function () {}), extra: 1'))).toBe(false);
    expect(isFacadeCode(sysProps('setters: [], extra: 1'))).toBe(false);
  });

  it('isFacadeCode round 21: a SystemJS export callback shadowed at any depth is not the callback', () => {
    const sys = (setter: string): string =>
      `System.register([], (function (exports) { return { setters: [${setter}], execute: (function () {}) }; }));`;
    expect(
      isFacadeCode(
        sys(
          'function (m) { Object.keys(m).forEach(function (k) { var exports = m.track; exports(k, 1); }); }',
        ),
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        sys('function (m) { Object.keys(m).forEach(function (exports) { exports(1); }); }'),
      ),
    ).toBe(false);
    expect(
      isFacadeCode(
        sys('function (m) { Object.keys(m).forEach(function (k) { exports(k, 1); }); }'),
      ),
    ).toBe(true);
    expect(
      isFacadeCode(
        sys(
          'function (m) { Object.keys(m).forEach(function (k) { if (k) { const exports = m; } }); }',
        ),
      ),
    ).toBe(false);
    // terser reuses the callback's name for a loop's own `const`: that is scoped to the loop, the callback is back after it
    expect(
      isFacadeCode(
        sys(
          'function (n) { const s = { __proto__: null }; for (const exports in n) s[exports] = n[exports]; exports(s); }',
        ),
      ),
    ).toBe(true);
    expect(
      isFacadeCode(sys("function (n) { for (const exports in n) { exports('a', 1); } }")),
    ).toBe(false);
    expect(isFacadeCode(sys('function (n) { for (const exports in n) exports(n); }'))).toBe(false);
    expect(isFacadeCode(sys("function (n) { for (var exports in n) { } exports('a', 1); }"))).toBe(
      false,
    ); // `var` is function-wide
    expect(isFacadeCode(sys("function (n) { for (let exports in n) { } exports('a', 1); }"))).toBe(
      true,
    );
    expect(isFacadeCode(sys('function (n) { for (const k in n) { exports(k, n[k]); } }'))).toBe(
      true,
    );
    expect(isFacadeCode(sys('function (n) { for (const exports in n) { } track(); }'))).toBe(false);
    expect(isFacadeCode(sys('function (n) { for (const exports in track(n)) { } }'))).toBe(false);
    expect(isFacadeCode(sys('function (n) { for (const [exports] in n) { } }'))).toBe(false);
  });

  it('isFacadeCode round 19: empty statements and comment boundaries', () => {
    expect(isFacadeCode(";export { a } from './a.js';")).toBe(true);
    expect(isFacadeCode("export{a}from'./a.js';;")).toBe(true);
    expect(isFacadeCode('function _interopX(e) { ; return e; }')).toBe(true);
    expect(isFacadeCode("export { a } from './a.js';\n/*\n// end */")).toBe(true);
    expect(isFacadeCode("/* x */ export{a}from'./a.js' // trailing")).toBe(true);
    expect(isFacadeCode("export{a}from'./a.js'; // _bugseeDebugIds")).toBe(true);
    expect(isFacadeCode("export{a}from'./a.js';\n/* open")).toBe(false); // unreadable
    // the stamp's stub is a STATEMENT followed by the debugId comment, wherever the comments are
    const stub = `\n!function(){var g=globalThis;g._bugseeDebugIds=g._bugseeDebugIds||{};g._bugseeDebugIds["x"]="${ID_A}"}();\n//# debugId=${ID_A}\n`;
    expect(isFacadeCode(`export{a}from'./m.js';${stub}/* trailing\n// block */`)).toBe(true);
    expect(isFacadeCode(`export{a}from'./m.js';/* a\n// b */${stub}`)).toBe(true);
    expect(
      isFacadeCode(`var d=globalThis._bugseeDebugIds;export function f(){return d}${stub}`),
    ).toBe(false);
    expect(isFacadeCode(`var d=globalThis._bugseeDebugIds;${stub}`)).toBe(false); // the var is real code
    expect(isFacadeCode(`export{a}from'./m.js';\n!function(){g._bugseeDebugIds={}}();`)).toBe(
      false,
    ); // no debugId comment: not the stub
  });

  it('isFacadeCode round 19: a hostile depth is "not a facade", never an exception', () => {
    const chain = `exports.a = x${'.p'.repeat(5000)};`;
    expect(() => isFacadeCode(chain)).not.toThrow();
    expect(isFacadeCode(chain)).toBe(false);
    expect(isFacadeCode(`ok${' && ok'.repeat(5000)} && Object.keys(x);`)).toBe(false);
    expect(isFacadeCode(`${'('.repeat(20000)}x${')'.repeat(20000)};`)).toBe(false);
    expect(isFacadeCode(`exports.a = ${'!'.repeat(5000)}x;`)).toBe(false);
    // statements nest too: a helper whose body is blocks inside blocks
    expect(
      isFacadeCode(`function _interopX(e) { ${'{'.repeat(100)}${'}'.repeat(100)} return e; }`),
    ).toBe(false);
    expect(
      isFacadeCode(`function _interopX(e) { ${'{'.repeat(10)}${'}'.repeat(10)} return e; }`),
    ).toBe(true);
    // a normal-depth chain is fine
    expect(isFacadeCode('exports.a = main.p.q.r.s;')).toBe(true);
  });

  it('a hostile bundle with an empty map costs one finding, not the whole report', async () => {
    put('a.js', `exports.a = x${'.p'.repeat(5000)};\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
    put(
      'a.js.map',
      JSON.stringify({ version: 3, sources: [], names: [], mappings: ';', debugId: ID_A }),
    );
    put('b.js', 'b');
    const report = await run();
    expect(ids(report)).not.toContain('doctor.internal-error');
    expect(find(report, 'map.no-sources')?.severity).toBe('error');
    expect(ids(report)).toContain('stamp.missing-debug-id'); // the rest of the audit is there
  });

  it('isFacadeCode: comments are stripped outside quoted module specifiers only', () => {
    for (const facade of [
      'export { a } from "https://cdn.example/a.js";',
      "import 'http://x.test/y.js' // a trailing comment",
      "/* don't */ export{a}from'./m.js'; // it's fine",
      "export{a}from'./m.js'; /* block with // inside */\nexport{b}from'./n.js'",
    ]) {
      expect(isFacadeCode(facade), facade).toBe(true);
    }
    expect(isFacadeCode("var u = 'http://x'; export{a}from'./m.js'")).toBe(false);
    expect(isFacadeCode("export{a}from'./m.js' /* unterminated")).toBe(false); // unreadable is not a facade
    expect(isFacadeCode("export{a}from'./m.js; export function f(){}")).toBe(false); // an open string swallows the rest
  });

  it('isFacadeCode: a registration-looking line is the stub only when the debugId comment follows it', () => {
    expect(isFacadeCode('var d=globalThis._bugseeDebugIds;\n// just a note\n')).toBe(false);
    expect(isFacadeCode('var d=globalThis._bugseeDebugIds;\n//# sourceMappingURL=a.map\n')).toBe(
      false,
    );
  });

  it('isFacadeCode: only the TRAILING registration stub is ignored, not the marker inside real code', () => {
    // a bundle that carries the Bugsee SDK has the marker in its own (minified, one-line) code
    const sdk = 'var d=globalThis._bugseeDebugIds;export function f(){return d}';
    expect(isFacadeCode(`${sdk}${stamp(ID_A)}`)).toBe(false);
    expect(isFacadeCode(`${sdk}\n`)).toBe(false);
    // a facade followed by the stub is fine, whatever comments and blank lines come after it
    expect(
      isFacadeCode(`export{a}from'./m.js';${stamp(ID_A)}\n\n//# sourceMappingURL=x.map\n`),
    ).toBe(true);
    // a marker in the MIDDLE of a facade-looking file does not make the code after it vanish
    expect(isFacadeCode(`var x=globalThis._bugseeDebugIds;\nexport{a}from'./m.js';`)).toBe(false);
  });

  it('only separators in mappings (";;;" or ",;") is still empty', async () => {
    for (const mappings of [';;;', ',;,', ';']) {
      pairOne(rollupEmpty({ debugId: ID_A, mappings }));
      expect(find(await run(), 'map.no-sources')?.severity, mappings).toBe('info');
    }
  });

  it('generated segments but no sources stays an error (a stripped map)', async () => {
    pairOne(rollupEmpty({ debugId: ID_A, mappings: 'AAAA' }));
    expect(find(await run(), 'map.no-sources')?.severity).toBe('error');
    pairOne(rollupEmpty({ debugId: ID_A, mappings: ';;A' }));
    expect(find(await run(), 'map.no-sources')?.severity).toBe('error');
  });

  it('index maps: empty when no section has segments; an error when any section does or the chain is too deep to tell', async () => {
    const leaf = (mappings: string, line: number) => ({
      offset: { line, column: 0 },
      map: { version: 3, sources: [], names: [], mappings },
    });
    pairOne(JSON.stringify({ version: 3, debugId: ID_A, sections: [leaf('', 0), leaf(';', 3)] }));
    expect(find(await run(), 'map.no-sources')?.severity).toBe('info');
    pairOne(
      JSON.stringify({ version: 3, debugId: ID_A, sections: [leaf('', 0), leaf('AAAA', 3)] }),
    );
    expect(find(await run(), 'map.no-sources')?.severity).toBe('error');
    let deep: Record<string, unknown> = { version: 3, sources: [], mappings: '' };
    for (let i = 0; i < 40; i++) {
      deep = { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: deep }] };
    }
    pairOne(JSON.stringify({ ...deep, debugId: ID_A }));
    expect(find(await run(), 'map.no-sources')?.severity).toBe('error'); // beyond the cap: cannot tell, so not waved through
  });

  it('an empty map that no bundle claims (there is no code to check) is a note', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put('a.js.map', mapJson({ debugId: ID_A }));
    put('orphan.css.map', rollupEmpty());
    expect(find(await run(), 'map.no-sources')).toMatchObject({
      severity: 'info',
      file: 'orphan.css.map',
    });
  });

  it('an empty map reached through aliases in different directories is noted once', async () => {
    put('real/app.js.map', rollupEmpty({ debugId: ID_A }));
    for (const d of ['a', 'b']) {
      put(`${d}/app.js`, `a\n//# sourceMappingURL=app.js.map${stamp(ID_A)}`);
      symlinkSync(join(dist, 'real', 'app.js.map'), join(dist, d, 'app.js.map'));
    }
    const noted = (await run()).findings.filter(
      (f) => f.id === 'map.no-sources' && !(f.file ?? '').startsWith('real/'),
    );
    expect(noted).toHaveLength(1);
  });

  it('a shared empty map is an error if ANY claimant has real code, whichever claims it first', async () => {
    const facade = `export{a}from'./m.js';${stamp(ID_A)}`;
    const real = `export function f(){return 1}\n${stamp(ID_A)}`;
    for (const [first, second] of [
      [facade, real],
      [real, facade],
    ] as const) {
      put('a.js', first.replace(stamp(ID_A), `\n//# sourceMappingURL=shared.map${stamp(ID_A)}`));
      put('b.js', second.replace(stamp(ID_A), `\n//# sourceMappingURL=shared.map${stamp(ID_A)}`));
      put('shared.map', rollupEmpty({ debugId: ID_A }));
      const noted = (await run()).findings.filter((f) => f.id === 'map.no-sources');
      expect(noted.map((f) => f.severity)).toEqual(['error']);
    }
    put('b.js', facade.replace(stamp(ID_A), `\n//# sourceMappingURL=shared.map${stamp(ID_A)}`));
    put('a.js', facade.replace(stamp(ID_A), `\n//# sourceMappingURL=shared.map${stamp(ID_A)}`));
    expect(
      (await run()).findings.filter((f) => f.id === 'map.no-sources').map((f) => f.severity),
    ).toEqual(['info']);
  });

  it('the same in different directories (aliases of one real map)', async () => {
    put('real/app.js.map', rollupEmpty({ debugId: ID_A }));
    const code = (c: string): string => `${c}\n//# sourceMappingURL=app.js.map${stamp(ID_A)}`;
    put('a/app.js', code("export{a}from'./m.js';"));
    put('b/app.js', code('export function f(){return 1}'));
    for (const d of ['a', 'b']) {
      symlinkSync(join(dist, 'real', 'app.js.map'), join(dist, d, 'app.js.map'));
    }
    const noted = (await run()).findings.filter(
      (f) => f.id === 'map.no-sources' && !(f.file ?? '').startsWith('real/'),
    );
    expect(noted.map((f) => f.severity)).toEqual(['error']);
  });

  it('a shared empty map is noted once', async () => {
    put('a.js', `a\n//# sourceMappingURL=shared.map${stamp(ID_A)}`);
    put('b.js', `b\n//# sourceMappingURL=shared.map${stamp(ID_A)}`);
    put('shared.map', rollupEmpty({ debugId: ID_A }));
    const report = await run();
    expect(report.findings.filter((f) => f.id === 'map.no-sources')).toHaveLength(1);
  });
});
