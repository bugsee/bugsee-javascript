// Robustness of the doctor: it must never throw, never read what it should not, never be quadratic, and must
// resolve sources the way the build did. Each test pins one reviewed failure mode.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DoctorReport, diagnoseBuildOutput, sourcePath, walk } from './doctor';
import { listOutputMaps } from './stamp-files';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

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

  it('a FIFO or symlink named as a map inside the directory is map.unreadable, not opened', async () => {
    put('a.js', `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
    if (!mkfifo(join(dist, 'a.js.map'))) {
      return;
    }
    put('real.map', mapJson({ debugId: ID_B }));
    put('b.js', `b\n//# sourceMappingURL=link.map${stamp(ID_B)}`);
    symlinkSync(join(dist, 'real.map'), join(dist, 'link.map'));
    const report = await run();
    const unreadable = report.findings.filter((f) => f.id === 'map.unreadable');
    expect(unreadable.map((f) => f.file).sort()).toEqual(['a.js.map', 'link.map']);
    expect(unreadable.find((f) => f.file === 'a.js.map')?.message).toContain('not a regular file');
    expect(unreadable.find((f) => f.file === 'link.map')?.message).toContain('symbolic link');
    expect(unreadable.every((f) => f.severity === 'error')).toBe(true);
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
    expect(sourcePath('/m', '', 'webpack://app/./src/x.ts', '/proj')).toBe('/proj/src/x.ts');
    expect(sourcePath('/m', '', 'webpack://app/./src/x.ts')).toBe('/m/src/x.ts');
    expect(sourcePath('/m/d', '../s', 'a.ts', '/proj')).toBe('/m/s/a.ts');
    expect(sourcePath('/m', '', '/abs/a.ts')).toBe('/abs/a.ts');
    expect(sourcePath('/m', '', 'file:///x/a%20b.ts')).toBe('/x/a b.ts');
    expect(sourcePath('/m', '', 'file:///x/%zz.ts')).toBeUndefined();
    expect(sourcePath('/m', '', 'webpack/runtime/x')).toBeUndefined();
    expect(sourcePath('/m', '', '')).toBeUndefined();
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
      expect(sourcePath('/m', '', virtual), virtual).toBeUndefined();
    }
    for (const real of ['webpackx/a.ts', 'viteish/a.ts', 'rollupx.ts', 'webpack.config.js']) {
      expect(sourcePath('/m', '', real), real).toBe(`/m/${real}`);
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
    } finally {
      chmodSync(dist, 0o700);
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

  it('a symlinked directory is never descended into by the walk', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'o.js'), 'x');
    symlinkSync(outside, join(dist, 'linkdir'));
    put('a.js', `a${stamp(ID_A)}`);
    expect((await walk(dist)).map((f) => f.slice(dist.length + 1))).toEqual(['a.js']);
  });

  it('a symlinked bundle is reported, not silently invisible (no misleading output.no-js)', async () => {
    const real = join(root, 'real.js');
    writeFileSync(real, `a${stamp(ID_A)}`);
    symlinkSync(real, join(dist, 'app.js'));
    const report = await run();
    expect(ids(report)).not.toContain('output.no-js');
    expect(find(report, 'output.unreadable')?.details).toEqual({
      files: ['app.js is a symbolic link'],
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
