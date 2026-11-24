import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOCTOR_USAGE, runDoctorCli } from './doctor-cli';

const ID = '11111111-1111-4111-8111-111111111111';
let root: string;
let dist: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-doctor-cli-'));
  dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(root, 'package.json'), '{"name":"a","version":"1.0.0"}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const stamped = `x\n!function(){globalThis._bugseeDebugIds={}}();\n//# debugId=${ID}\n`;

async function cli(argv: string[], env = { BUGSEE_APP_TOKEN: 't', BUGSEE_APP_BUILD: 'b' }) {
  let out = '';
  let err = '';
  const code = await runDoctorCli(argv, {
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    env,
  });
  return { code, out, err };
}

describe('runDoctorCli --exclude', () => {
  it('drops matching files before analysis; repeatable; needs a value', async () => {
    writeFileSync(join(dist, 'a.js'), stamped);
    mkdirSync(join(dist, 'public'));
    writeFileSync(join(dist, 'public', 'sw.js'), 'x');
    writeFileSync(join(dist, 'vendor.js'), 'x');
    expect((await cli([dist, '--no-env', '--json'])).code).toBe(0);
    const ids = async (args: string[]) =>
      JSON.parse((await cli([dist, '--no-env', '--json', ...args])).out).findings.map(
        (f: { id: string }) => f.id,
      );
    expect(await ids(['--exclude', 'public/**'])).toContain('output.excluded');
    expect(await ids(['--exclude', 'public/**'])).toContain('stamp.missing-debug-id'); // vendor.js remains
    const both = await ids(['--exclude=public/**', '--exclude', 'vendor.js']);
    expect(both).not.toContain('stamp.missing-debug-id');
    expect(both).not.toContain('stamp.mixed');
    expect((await cli([dist, '--exclude'])).code).toBe(2);
  });
});

describe('runDoctorCli', () => {
  it('prints the text report and exits 0 for a clean build', async () => {
    writeFileSync(join(dist, 'a.js'), stamped);
    const { code, out, err } = await cli([dist, '--project-root', root]);
    expect(code).toBe(0);
    expect(out).toContain('The app token comes from the BUGSEE_APP_TOKEN environment variable.');
    expect(out).not.toContain('t,'); // the value is never printed
    expect(err).toBe('');
  });

  it('--json prints a parseable report; exit 2 on errors', async () => {
    writeFileSync(join(dist, 'a.js'), 'x\n//# sourceMappingURL=a.js.map');
    writeFileSync(join(dist, 'a.js.map'), '{"version":3,"sources":["a"]}');
    const { code, out } = await cli([dist, '--json', '--no-env']);
    expect(code).toBe(2);
    const report = JSON.parse(out);
    expect(report.schemaVersion).toBe(1);
    expect(report.findings.map((f: { id: string }) => f.id)).toContain('stamp.missing-debug-id');
  });

  it('--strict turns warnings into exit 1; without it they are exit 0', async () => {
    writeFileSync(join(dist, 'vendor.js'), 'x');
    expect((await cli([dist, '--no-env'])).code).toBe(0);
    expect((await cli([dist, '--no-env', '--strict'])).code).toBe(1);
  });

  it('a missing token is a warning (exit 0; 1 under --strict); --no-env drops the check', async () => {
    writeFileSync(join(dist, 'a.js'), stamped);
    const base = [dist, '--project-root', root, '--json'];
    const warned = await cli(base, {} as never);
    expect(warned.code).toBe(0);
    expect(JSON.parse(warned.out).findings.map((f: { id: string }) => f.id)).toContain(
      'env.token-missing',
    );
    expect((await cli([...base, '--strict'], {} as never)).code).toBe(1);
    const skipped = await cli([...base, '--no-env', '--strict'], {} as never);
    expect(skipped.code).toBe(0);
  });

  it('--strict passes straight after a plugin run: stamped bundle, maps removed, pointer left', async () => {
    writeFileSync(join(dist, 'a.js'), `x\n//# sourceMappingURL=a.js.map${stamped}`);
    const { code } = await cli([dist, '--project-root', root, '--strict']);
    expect(code).toBe(0);
  });

  it('--deployed makes leftover maps a warning; --ignore drops an ID (repeatable)', async () => {
    writeFileSync(join(dist, 'a.js'), stamped);
    writeFileSync(
      join(dist, 'a.js.map'),
      JSON.stringify({ version: 3, debugId: ID, sources: ['a'], sourcesContent: ['x'] }),
    );
    const args = [dist, '--no-env', '--strict'];
    expect((await cli(args)).code).toBe(0);
    expect((await cli([...args, '--deployed'])).code).toBe(1);
    const ignored = await cli([
      ...args,
      '--deployed',
      '--ignore',
      'map.public-leftover',
      '--ignore',
      'x',
      '--json',
    ]);
    expect(ignored.code).toBe(0);
    expect(JSON.parse(ignored.out).ignored).toEqual(['map.public-leftover']);
  });

  it('`--` ends options, so a directory can start with a dash', async () => {
    const odd = join(root, '-odd');
    mkdirSync(odd);
    writeFileSync(join(odd, 'a.js'), stamped);
    const { code, out } = await cli(['--no-env', '--', odd]);
    expect(code).toBe(0);
    expect(out).toContain('1 bundle(s)');
    expect((await cli(['--', odd, 'second'])).code).toBe(2);
  });

  it('a single-dash unknown flag is rejected, not taken for the directory', async () => {
    const { code, err } = await cli(['-x', dist]);
    expect(code).toBe(2);
    expect(err).toContain('Unknown option -x');
  });

  it('--max-map-mb sets the large-map threshold', async () => {
    writeFileSync(join(dist, 'a.js'), stamped);
    writeFileSync(
      join(dist, 'a.js.map'),
      JSON.stringify({
        version: 3,
        debugId: ID,
        sources: ['a'],
        sourcesContent: ['x'.repeat(2000)],
      }),
    );
    const small = await cli([dist, '--no-env', '--max-map-mb', '0.001', '--json']);
    expect(JSON.parse(small.out).findings.map((f: { id: string }) => f.id)).toContain(
      'map.too-large',
    );
    // 2000 bytes against 1 MiB: only the right unit (MiB, not KiB) leaves it unflagged
    const oneMb = await cli([dist, '--no-env', '--max-map-mb', '1', '--json']);
    expect(JSON.parse(oneMb.out).findings.map((f: { id: string }) => f.id)).not.toContain(
      'map.too-large',
    );
    const big = await cli([dist, '--no-env', '--json']);
    expect(JSON.parse(big.out).findings.map((f: { id: string }) => f.id)).not.toContain(
      'map.too-large',
    );
  });

  it('--key=value forms work for every option that takes a value', async () => {
    writeFileSync(join(dist, 'a.js'), stamped);
    writeFileSync(
      join(dist, 'a.js.map'),
      JSON.stringify({
        version: 3,
        debugId: ID,
        sources: ['a'],
        sourcesContent: ['x'.repeat(2000)],
      }),
    );
    const small = await cli([dist, '--no-env', '--max-map-mb=0.001', '--json']);
    expect(JSON.parse(small.out).findings.map((f: { id: string }) => f.id)).toContain(
      'map.too-large',
    );
    const ignored = await cli([
      dist,
      '--no-env',
      '--ignore=map.public-leftover',
      `--project-root=${root}`,
      '--json',
    ]);
    expect(JSON.parse(ignored.out).ignored).toEqual(['map.public-leftover']);
    expect((await cli([dist, '--max-map-mb='])).code).toBe(2);
  });

  it('`--=x` is an unknown option, not the end-of-options marker', async () => {
    const { code, err } = await cli(['--=x', dist]);
    expect(code).toBe(2);
    expect(err).toContain('Unknown option --');
  });

  it.each([
    '--json',
    '--strict',
    '--no-env',
    '--deployed',
    '--help',
  ])('%s takes no value: `=value` is a usage error, not silently dropped', async (flag) => {
    const { code, out, err } = await cli([dist, `${flag}=false`]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain(`${flag} does not take a value`);
  });

  it('after `--`, an argument containing `=` is a plain directory name', async () => {
    const odd = join(root, '--odd=dir');
    mkdirSync(odd);
    writeFileSync(join(odd, 'a.js'), stamped);
    const here = process.cwd();
    process.chdir(root);
    try {
      const { code, out } = await cli(['--no-env', '--', '--odd=dir']);
      expect(code).toBe(0);
      expect(out).toContain('--odd=dir');
      expect(out).toContain('1 bundle(s)');
    } finally {
      process.chdir(here);
    }
  });

  it('`--project-root=--x` takes the value; `-- --a=b` is one directory (not truncated at `=`)', async () => {
    writeFileSync(join(dist, 'a.js'), stamped);
    const { code } = await cli([dist, '--project-root=--x', '--json']);
    expect(code).toBe(0);
    const here = process.cwd();
    process.chdir(root);
    try {
      mkdirSync(join(root, '--a=b'));
      const out = await cli(['--no-env', '--', '--a=b']);
      expect(out.out).toContain('--a=b');
      expect(out.out).toContain('0 bundle(s)');
    } finally {
      process.chdir(here);
    }
  });

  it('--ignore of a hard-failure ID warns that it cannot be ignored and still fails', async () => {
    const { code, err } = await cli([
      join(root, 'nope'),
      '--no-env',
      '--ignore',
      'output.dir-missing',
    ]);
    expect(code).toBe(2);
    expect(err).toContain('output.dir-missing cannot be ignored');
  });

  it('an unknown --ignore ID is warned about on stderr but not fatal', async () => {
    writeFileSync(join(dist, 'a.js'), stamped);
    const { code, err } = await cli([dist, '--no-env', '--ignore', 'map.public-leftvoer']);
    expect(code).toBe(0);
    expect(err).toContain('map.public-leftvoer is not a known check ID');
    expect((await cli([dist, '--no-env', '--ignore', 'map.public-leftover'])).err).toBe('');
  });

  it('--help prints usage and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const { code, out } = await cli([flag]);
      expect(code).toBe(0);
      expect(out).toBe(`${DOCTOR_USAGE}\n`);
    }
  });

  it.each([
    [[], 'Missing the build output directory'],
    [['a', 'b'], 'Unexpected argument b'],
    [['a', '--bogus'], 'Unknown option --bogus'],
    [['a', '--project-root'], '--project-root needs a value'],
    [['a', '--max-map-mb', '--json'], '--max-map-mb needs a value'],
    [['a', '--max-map-mb', 'abc'], 'positive number, got "abc"'],
    [['a', '--max-map-mb', '0'], 'positive number, got "0"'],
  ])('usage error for %j', async (argv, message) => {
    const { code, out, err } = await cli(argv as string[]);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toContain(message);
    expect(err).toContain('Usage: bugsee-sourcemaps-doctor');
  });
});
