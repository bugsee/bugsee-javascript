// Robustness of the doctor: it must never throw, never read what it should not, never be quadratic, and must
// resolve sources the way the build did. Each test pins one reviewed failure mode.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import {
  batchEnd,
  type DoctorReport,
  diagnoseBuildOutput,
  doctorExitCode,
  sourcePath,
  walk,
} from './doctor';
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
      for (const pattern of ['vendor', 'vendor*', 'vendor/*', '*', 'assets/*']) {
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

  it('a symlinked directory is never descended into by the walk', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'o.js'), 'x');
    symlinkSync(outside, join(dist, 'linkdir'));
    put('a.js', `a${stamp(ID_A)}`);
    expect((await walk(dist)).map((f) => f.slice(dist.length + 1))).toEqual(['a.js']);
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
  const index = (sections: unknown[], extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ version: 3, sections, ...extra });
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
    pair(index([], { debugId: ID_A }));
    expect(ids(await run())).toContain('map.no-sources');
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
    put('pages/real.html', stalePage.replace('a.js', '../a.js'));
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
    expect(sourcePath(map, 'webpack:///', 'src/x.ts', proj)).toBe('/p/src/x.ts');
    expect(sourcePath(map, 'webpack:///', 'webpack://app/src/x.ts', proj)).toBe('/p/src/x.ts');
    expect(sourcePath(map, 'webpack:///', 'file:///tmp/y.ts', proj)).toBe('/tmp/y.ts');
    expect(sourcePath(map, 'webpack:///', '/abs/z.ts', proj)).toBe('/abs/z.ts');
    expect(sourcePath(map, 'https://h/r', '/abs/z.ts', proj)).toBe('/abs/z.ts');
    // a non-URL source with a single-colon scheme is not joined to the root either: it resolves from the map
    expect(sourcePath(map, 'webpack:///', 'node:fs', proj)).toBe('/p/dist/webpack:/node:fs');
  });
});
