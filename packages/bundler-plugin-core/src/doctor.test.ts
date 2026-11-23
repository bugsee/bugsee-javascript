import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOCTOR_CHECK_IDS,
  DOCTOR_SCHEMA_VERSION,
  type DoctorReport,
  diagnoseBuildOutput,
  doctorExitCode,
  formatDoctorReport,
} from './doctor';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

let root: string;
let dist: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-doctor-'));
  dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

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
    sourcesContent: ['export const a = 1;'],
    names: [],
    mappings: 'AAAA',
    ...extra,
  });

/** A fully stamped bundle + matching hidden map. */
const goodPair = (name = 'app.js', id = ID_A): void => {
  put(name, `console.log(1);${stamp(id)}`);
  put(`${name}.map`, mapJson({ debugId: id }));
};

const ENV = { BUGSEE_APP_TOKEN: 'secret-token-value', BUGSEE_APP_BUILD: 'abc' };
const run = (options: Parameters<typeof diagnoseBuildOutput>[1] = {}): Promise<DoctorReport> =>
  diagnoseBuildOutput(dist, { env: ENV, projectRoot: root, ...options });
const ids = (report: DoctorReport): string[] => report.findings.map((f) => f.id);
const sev = (report: DoctorReport, id: string): string | undefined =>
  report.findings.find((f) => f.id === id)?.severity;

describe('diagnoseBuildOutput', () => {
  it('a stamped bundle with a matching hidden map is clean except the public-leftover warning', async () => {
    goodPair();
    const report = await run();
    expect(report.schemaVersion).toBe(DOCTOR_SCHEMA_VERSION);
    expect(report.tool).toBe('bugsee-sourcemaps-doctor');
    expect(report.summary).toMatchObject({ errors: 0, bundles: 1, maps: 1 });
    expect(ids(report).sort()).toEqual([
      'map.hidden',
      'map.public-leftover',
      'map.sources-content',
    ]);
    expect(sev(report, 'map.public-leftover')).toBe('warning');
    expect(report.passed).toContain('stamp.missing-debug-id');
    expect(report.passed).not.toContain('map.public-leftover');
    // info-only facts are not "passed" checks
    expect(report.passed).not.toContain('map.hidden');
  });

  it('after deleteMaps (bundle stamped, no maps) nothing is wrong', async () => {
    put('app.js', `console.log(1);${stamp(ID_A)}`);
    const report = await run();
    expect(report.findings).toEqual([]);
    expect(doctorExitCode(report)).toBe(0);
    expect(doctorExitCode(report, true)).toBe(0);
  });

  it('output.dir-missing: a path that is not a directory', async () => {
    const report = await diagnoseBuildOutput(join(root, 'nope'), { env: ENV });
    expect(ids(report)).toEqual(['output.dir-missing']);
    expect(report.passed).toEqual([]);
    expect(doctorExitCode(report)).toBe(2);
    const asFile = await diagnoseBuildOutput(join(root, 'package.json'), { env: ENV });
    expect(ids(asFile)).toEqual(['output.dir-missing']);
  });

  it('output.no-js: a directory with no scripts (and node_modules/src/dot dirs are not searched)', async () => {
    put('index.html', '<html></html>');
    put('node_modules/x/y.js', 'x');
    put('src/z.js', 'x');
    put('.hidden/h.js', 'x');
    const report = await run();
    expect(ids(report)).toContain('output.no-js');
    expect(sev(report, 'output.no-js')).toBe('error');
    expect(report.summary.bundles).toBe(0);
  });

  it('stamp.missing-debug-id: an unstamped bundle WITH a map is an error', async () => {
    put('app.js', 'console.log(1);\n//# sourceMappingURL=app.js.map');
    put('app.js.map', mapJson());
    const report = await run();
    const finding = report.findings.find((f) => f.id === 'stamp.missing-debug-id');
    expect(finding).toMatchObject({ severity: 'error', file: 'app.js' });
    expect(finding?.fix).toContain('sourcemaps inject');
    expect(doctorExitCode(report)).toBe(2);
  });

  it('stamp.missing-debug-id: an unstamped bundle with NO map is only a warning', async () => {
    put('vendor.js', 'console.log(1);');
    const report = await run();
    expect(report.findings.find((f) => f.id === 'stamp.missing-debug-id')).toMatchObject({
      severity: 'warning',
      details: { files: ['vendor.js'] },
    });
    expect(doctorExitCode(report)).toBe(0);
    expect(doctorExitCode(report, true)).toBe(1);
  });

  it('stamp.missing-debug-id: a bundle that lost its stamp while its map kept the id', async () => {
    put('app.js', 'console.log(1);');
    put('app.js.map', mapJson({ debugId: ID_A }));
    const report = await run();
    const found = report.findings.filter((f) => f.id === 'stamp.missing-debug-id');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', details: { mapDebugId: ID_A } });
  });

  it('stamp.missing-registration: a comment alone is not a stamp', async () => {
    put('app.js', `console.log(1);\n//# debugId=${ID_A}\n`);
    const report = await run();
    expect(sev(report, 'stamp.missing-registration')).toBe('error');
    expect(report.findings.find((f) => f.id === 'stamp.missing-registration')?.details).toEqual({
      files: ['app.js'],
    });
  });

  it('stamp.map-id-mismatch / stamp.map-no-debug-id', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put('a.js.map', mapJson({ debugId: ID_B }));
    put('b.js', `b${stamp(ID_B)}`);
    put('b.js.map', mapJson());
    const report = await run();
    expect(report.findings.find((f) => f.id === 'stamp.map-id-mismatch')).toMatchObject({
      severity: 'error',
      file: 'a.js.map',
      details: { bundleDebugId: ID_A, mapDebugId: ID_B },
    });
    expect(report.findings.find((f) => f.id === 'stamp.map-no-debug-id')).toMatchObject({
      severity: 'error',
      file: 'b.js.map',
    });
  });

  it('accepts the snake_case debug_id spelling in the map and compares case-insensitively', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put('a.js.map', mapJson({ debug_id: ID_A.toUpperCase() }));
    const report = await run();
    expect(ids(report)).not.toContain('stamp.map-id-mismatch');
    expect(ids(report)).not.toContain('stamp.map-no-debug-id');
  });

  it('stamp.mixed: some bundles stamped, some not', async () => {
    goodPair('a.js', ID_A);
    put('b.js', 'b\n//# sourceMappingURL=b.js.map');
    put('b.js.map', mapJson());
    const report = await run();
    expect(report.findings.find((f) => f.id === 'stamp.mixed')).toMatchObject({
      severity: 'warning',
      details: { stamped: 1, unstamped: 1 },
    });
  });

  it('stamp.duplicate-debug-id: same id, different contents; identical copies are fine', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put('b.js', `different${stamp(ID_A)}`);
    put('c.js', `same${stamp(ID_B)}`);
    put('d.js', `same${stamp(ID_B)}`);
    const report = await run();
    const dup = report.findings.filter((f) => f.id === 'stamp.duplicate-debug-id');
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({
      severity: 'error',
      details: { debugId: ID_A, files: ['a.js', 'b.js'] },
    });
  });

  it('map.pointer-dangling: the pointer names a map that is not there; hidden maps are noted', async () => {
    put('a.js', `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
    put('b.js', `b\n//# sourceMappingURL=https://cdn.example/b.js.map${stamp(ID_B)}`);
    const report = await run();
    const found = report.findings.find((f) => f.id === 'map.pointer-dangling');
    expect(found).toMatchObject({
      severity: 'warning',
      details: { pointers: ['a.js -> a.js.map'] },
    });
  });

  it('a pointer to a map in another directory resolves relative to the bundle', async () => {
    put('js/a.js', `a\n//# sourceMappingURL=../maps/a.js.map${stamp(ID_A)}`);
    put('maps/a.js.map', mapJson({ debugId: ID_B }));
    const report = await run();
    expect(report.findings.find((f) => f.id === 'stamp.map-id-mismatch')?.file).toBe(
      'maps/a.js.map',
    );
    expect(ids(report)).not.toContain('map.pointer-dangling');
  });

  it('map.inline: a data: map has nothing to upload', async () => {
    put('a.js', `a\n//# sourceMappingURL=data:application/json;base64,e30=${stamp(ID_A)}`);
    put('b.js', 'b\n//# sourceMappingURL=data:application/json;base64,e30=');
    const report = await run();
    expect(report.findings.find((f) => f.id === 'map.inline')).toMatchObject({
      severity: 'error',
      details: { files: ['a.js', 'b.js'] },
    });
    // the unstamped inline bundle is an error even though it has no .map file
    expect(report.findings.find((f) => f.id === 'stamp.missing-debug-id')).toMatchObject({
      severity: 'error',
      file: 'b.js',
    });
  });

  it('map.invalid: not JSON, not an object, wrong version; also for a map nothing points at', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put('a.js.map', '{not json');
    put('b.js', `b${stamp(ID_B)}`);
    put('b.js.map', '[]');
    put('c.js', 'c');
    put('c.js.map', mapJson({ version: 2 }));
    put('style.css.map', 'nope');
    put('other.css.map', mapJson({ version: 2 }));
    const report = await run();
    const invalid = report.findings.filter((f) => f.id === 'map.invalid');
    expect(invalid.map((f) => f.file).sort()).toEqual([
      'a.js.map',
      'b.js.map',
      'c.js.map',
      'other.css.map',
      'style.css.map',
    ]);
    expect(invalid.find((f) => f.file === 'a.js.map')?.message).toContain('not valid JSON');
    expect(invalid.find((f) => f.file === 'b.js.map')?.message).toContain('not a JSON object');
    expect(invalid.find((f) => f.file === 'c.js.map')?.message).toContain('version is 2');
  });

  it('map.no-sources: missing or empty `sources`', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put('a.js.map', mapJson({ debugId: ID_A, sources: [] }));
    put('b.js', `b${stamp(ID_B)}`);
    put('b.js.map', JSON.stringify({ version: 3, debugId: ID_B, mappings: '' }));
    const report = await run();
    expect(report.findings.filter((f) => f.id === 'map.no-sources').map((f) => f.file)).toEqual([
      'a.js.map',
      'b.js.map',
    ]);
  });

  it('map.sources-content: embedded is a fact; absent AND unresolvable is a warning; absent but on disk is a fact', async () => {
    put('a.js', `a${stamp(ID_A)}`);
    put(
      'a.js.map',
      mapJson({
        debugId: ID_A,
        sourcesContent: undefined,
        sources: ['../src/gone.ts', 'webpack/runtime/x'],
      }),
    );
    put('b.js', `b${stamp(ID_B)}`);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'here.ts'), 'x');
    put(
      'b.js.map',
      mapJson({ debugId: ID_B, sourcesContent: [null], sources: ['../src/here.ts'] }),
    );
    const report = await run();
    const a = report.findings.find((f) => f.id === 'map.sources-unresolvable');
    expect(a).toMatchObject({
      severity: 'warning',
      file: 'a.js.map',
      details: { unresolved: 1, total: 2 },
    });
    expect(a?.message).toContain('../src/gone.ts');
    const b = report.findings.find((f) => f.id === 'map.sources-content' && f.file === 'b.js.map');
    expect(b).toMatchObject({ severity: 'info', details: { embedded: 0, total: 1 } });
  });

  it('sources resolve through sourceRoot, file:// and bundler-scheme prefixes', async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'x');
    writeFileSync(join(root, 'src', 'b.ts'), 'x');
    writeFileSync(join(root, 'src', 'c.ts'), 'x');
    put('a.js', `a${stamp(ID_A)}`);
    put(
      'a.js.map',
      mapJson({
        debugId: ID_A,
        sourcesContent: undefined,
        sourceRoot: '../src/',
        sources: ['a.ts'],
      }),
    );
    put('b.js', `b${stamp(ID_B)}`);
    put(
      'b.js.map',
      mapJson({
        debugId: ID_B,
        sourcesContent: undefined,
        sources: [`file://${join(root, 'src', 'b.ts')}`],
      }),
    );
    put('c.js', 'c');
    put(
      'c.js.map',
      mapJson({
        debugId: ID_A,
        sourcesContent: undefined,
        sourceRoot: '..',
        sources: ['webpack://app/src/c.ts', '\0virtual', '<anonymous>'],
      }),
    );
    const report = await run();
    expect(ids(report)).not.toContain('map.sources-unresolvable');
  });

  it('map.too-large: warns above the threshold', async () => {
    goodPair();
    const report = await run({ maxMapBytes: 10 });
    expect(report.findings.find((f) => f.id === 'map.too-large')).toMatchObject({
      severity: 'warning',
      file: 'app.js.map',
    });
    expect((await run()).findings.map((f) => f.id)).not.toContain('map.too-large');
  });

  it('build.dev-bundle: webpack eval-style output', async () => {
    put('main.js', `eval("x\\n//# sourceURL=webpack-internal:///./src/a.ts");`);
    const report = await run();
    expect(report.findings.find((f) => f.id === 'build.dev-bundle')).toMatchObject({
      severity: 'warning',
      details: { files: ['main.js'] },
    });
  });

  describe('SRI', () => {
    const sri = (bytes: string | Buffer): string =>
      `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

    it('sri.unstamped-hazard: a pinned script that would be broken by stamping', async () => {
      const js = 'console.log(1);';
      put('app.js', js);
      put('index.html', `<script src="app.js" integrity="${sri(js)}"></script>`);
      const report = await run();
      expect(report.findings.find((f) => f.id === 'sri.unstamped-hazard')).toMatchObject({
        severity: 'warning',
        details: { scripts: ['app.js'] },
      });
      expect(ids(report)).not.toContain('sri.mismatch');
    });

    it('a pin to a script that is not on disk is ignored', async () => {
      put('app.js', `c${stamp(ID_A)}`);
      put('index.html', `<script src="gone.js" integrity="${sri('x')}"></script>`);
      const report = await run();
      expect(ids(report)).not.toContain('sri.unstamped-hazard');
    });

    it('a stamped script whose pin matches its bytes is fine', async () => {
      const js = `console.log(1);${stamp(ID_A)}`;
      put('app.js', js);
      put('index.html', `<script src="app.js" integrity="${sri(js)}"></script>`);
      const report = await run();
      expect(ids(report)).not.toContain('sri.unstamped-hazard');
      expect(ids(report)).not.toContain('sri.mismatch');
      expect(report.passed).toContain('sri.mismatch');
    });

    it('sri.mismatch: stamped AFTER the page was hashed', async () => {
      put('app.js', `console.log(1);${stamp(ID_A)}`);
      put('index.html', `<script src="app.js" integrity="${sri('console.log(1);')}"></script>`);
      const report = await run();
      expect(report.findings.find((f) => f.id === 'sri.mismatch')).toMatchObject({
        severity: 'error',
        details: { scripts: ['app.js'] },
      });
      expect(report.findings.find((f) => f.id === 'sri.mismatch')?.message).toContain('refuses');
    });

    it('sri.outside-dir: a manifest in the dir or an HTML page in the parent pins hashes', async () => {
      put('app.js', `c${stamp(ID_A)}`);
      put('asset-manifest.json', JSON.stringify({ 'app.js': { integrity: sri('x') } }));
      put('plain-manifest.json', '{}');
      put('readme.txt', 'integrity');
      writeFileSync(
        join(root, 'index.html'),
        `<script src="dist/app.js" integrity="${sri('x')}"></script>`,
      );
      writeFileSync(join(root, 'about.html'), '<p>no pins</p>');
      writeFileSync(join(root, 'pins-manifest.json'), `{"h":"${sri('y')}"}`);
      const report = await run();
      const found = report.findings.find((f) => f.id === 'sri.outside-dir');
      expect(found?.severity).toBe('warning');
      expect((found?.details?.files as string[]).sort()).toEqual([
        '../index.html',
        '../pins-manifest.json',
        'asset-manifest.json',
      ]);
    });
  });

  describe('environment', () => {
    it('env.token-missing is an error and never echoes a token; the source is not printed either', async () => {
      goodPair();
      const report = await run({ env: {} });
      expect(report.findings.find((f) => f.id === 'env.token-missing')?.severity).toBe('error');
      const withToken = await run({ appToken: 'super-secret' });
      expect(JSON.stringify(withToken)).not.toContain('super-secret');
      expect(JSON.stringify(withToken)).not.toContain('secret-token-value');
      expect(ids(withToken)).not.toContain('env.token-missing');
      // whitespace-only counts as unset
      expect(ids(await run({ env: { BUGSEE_APP_TOKEN: '  ' } }))).toContain('env.token-missing');
      expect(ids(await run({ env: {}, appToken: '  ' }))).toContain('env.token-missing');
    });

    it('env.version-unresolved / env.build-unresolved', async () => {
      goodPair();
      const lonely = mkdtempSync(join(tmpdir(), 'bugsee-doctor-lonely-'));
      try {
        const report = await run({ env: { BUGSEE_APP_TOKEN: 't' }, projectRoot: lonely });
        expect(sev(report, 'env.version-unresolved')).toBe('warning');
        expect(sev(report, 'env.build-unresolved')).toBe('info');
        const explicit = await run({
          env: { BUGSEE_APP_TOKEN: 't' },
          projectRoot: lonely,
          appVersion: '9.9.9',
          appBuild: '7',
        });
        expect(ids(explicit)).not.toContain('env.version-unresolved');
        expect(ids(explicit)).not.toContain('env.build-unresolved');
      } finally {
        rmSync(lonely, { recursive: true, force: true });
      }
    });

    it('env.node-env-development', async () => {
      goodPair();
      expect(
        sev(await run({ env: { ...ENV, NODE_ENV: 'development' } }), 'env.node-env-development'),
      ).toBe('warning');
      expect(ids(await run({ env: { ...ENV, NODE_ENV: 'production' } }))).not.toContain(
        'env.node-env-development',
      );
    });

    it('skipEnv drops every env.* check', async () => {
      goodPair();
      const report = await run({ env: {}, skipEnv: true });
      expect(ids(report).filter((id) => id.startsWith('env.'))).toEqual([]);
      expect(report.passed.filter((id) => id.startsWith('env.'))).toEqual([]);
    });
  });

  it('walks only MAX_WALK_DEPTH levels down', async () => {
    put('a/b/c/d/e/f/g/h/deep.js', 'x');
    put('a/b/c/d/e/f/ok.js', 'x');
    const report = await run();
    expect(report.summary.bundles).toBe(1);
  });

  it('a map pointer that resolves to a directory is skipped, not a crash', async () => {
    put('a.js', `a\n//# sourceMappingURL=a.js.map${stamp(ID_A)}`);
    mkdirSync(join(dist, 'a.js.map'));
    const report = await run();
    expect(report.summary.bundles).toBe(1);
    expect(ids(report)).not.toContain('map.invalid');
  });

  const describePerm = process.getuid?.() === 0 ? describe.skip : describe;
  describePerm('unreadable paths', () => {
    it('an unreadable sub-directory contributes nothing; an unreadable parent adds no outside-dir hints', async () => {
      put('a.js', `a${stamp(ID_A)}`);
      mkdirSync(join(dist, 'locked'));
      writeFileSync(join(dist, 'locked', 'x.js'), 'x');
      chmodSync(join(dist, 'locked'), 0o000);
      chmodSync(root, 0o300);
      try {
        const report = await run({ skipEnv: true });
        expect(report.summary.bundles).toBe(1);
        expect(ids(report)).not.toContain('sri.outside-dir');
      } finally {
        chmodSync(root, 0o700);
        chmodSync(join(dist, 'locked'), 0o700);
      }
    });

    it('an unreadable manifest is ignored', async () => {
      put('a.js', `a${stamp(ID_A)}`);
      const manifest = put('asset-manifest.json', '{"integrity":1}');
      chmodSync(manifest, 0o000);
      try {
        expect(ids(await run({ skipEnv: true }))).not.toContain('sri.outside-dir');
      } finally {
        chmodSync(manifest, 0o600);
      }
    });
  });

  it('every check ID is unique and namespaced', () => {
    expect(new Set(DOCTOR_CHECK_IDS).size).toBe(DOCTOR_CHECK_IDS.length);
    for (const id of DOCTOR_CHECK_IDS) {
      expect(id).toMatch(/^(output|stamp|map|sri|build|env)\.[a-z-]+$/);
    }
  });
});

describe('doctorExitCode / formatDoctorReport', () => {
  const report = (errors: number, warnings: number): DoctorReport => ({
    schemaVersion: 1,
    tool: 'bugsee-sourcemaps-doctor',
    dir: '/d',
    summary: { errors, warnings, infos: 0, bundles: 0, maps: 0 },
    passed: [],
    findings: [],
  });

  it('exit codes: 2 on errors, 1 on warnings only under strict, else 0', () => {
    expect(doctorExitCode(report(1, 1), true)).toBe(2);
    expect(doctorExitCode(report(0, 1), true)).toBe(1);
    expect(doctorExitCode(report(0, 1))).toBe(0);
    expect(doctorExitCode(report(0, 0), true)).toBe(0);
  });

  it('renders errors before warnings before notes, with fix hints', async () => {
    put('vendor.js', 'x');
    put('app.js', `c${stamp(ID_A)}`);
    put('app.js.map', mapJson({ debugId: ID_B }));
    const text = formatDoctorReport(await run());
    const error = text.indexOf('ERROR  [stamp.map-id-mismatch]');
    const warn = text.indexOf('WARN   [stamp.missing-debug-id]');
    const info = text.indexOf('info   [map.sources-content]');
    expect(error).toBeGreaterThan(-1);
    expect(warn).toBeGreaterThan(error);
    expect(info).toBeGreaterThan(warn);
    expect(text).toContain('        fix: ');
    expect(text).toContain('2 bundle(s), 1 map(s): 1 error(s)');
  });

  it('says so when there is nothing to report', () => {
    expect(formatDoctorReport(report(0, 0))).toContain('No problems found.');
  });
});
