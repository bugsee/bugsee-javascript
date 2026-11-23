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

describe('runDoctorCli', () => {
  it('prints the text report and exits 0 for a clean build', async () => {
    writeFileSync(join(dist, 'a.js'), stamped);
    const { code, out, err } = await cli([dist, '--project-root', root]);
    expect(code).toBe(0);
    expect(out).toContain('No problems found.');
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

  it('--no-env skips the token check; without it a missing token is an error', async () => {
    writeFileSync(join(dist, 'a.js'), stamped);
    expect((await cli([dist, '--no-env'], {} as never)).code).toBe(0);
    expect((await cli([dist, '--project-root', root], {} as never)).code).toBe(2);
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
    const big = await cli([dist, '--no-env', '--json']);
    expect(JSON.parse(big.out).findings.map((f: { id: string }) => f.id)).not.toContain(
      'map.too-large',
    );
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
