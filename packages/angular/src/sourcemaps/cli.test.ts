import { describe, expect, it, vi } from 'vitest';
import { HELP, parseArgs, runCli } from './cli';
import type { AngularUploadOptions, AngularUploadResult } from './upload';

describe('parseArgs', () => {
  it('reads every option, in both the spaced and the = form', () => {
    expect(
      parseArgs([
        '--project',
        'demo',
        '--configuration=production',
        '--dist',
        'out',
        '--app-version=1.0.0',
        '--app-build',
        '42',
        '--endpoint',
        'https://api.test',
        '--dry-run',
        '--keep-maps',
        '--fail-on-error',
        '--strip-sources-content',
        '--upload-in-development',
        '--no-vcs',
      ]),
    ).toEqual({
      options: {
        project: 'demo',
        configuration: 'production',
        dist: 'out',
        appVersion: '1.0.0',
        appBuild: '42',
        endpoint: 'https://api.test',
        dryRun: true,
        deleteMaps: false,
        failOnError: true,
        stripSourcesContent: true,
        uploadInDevelopment: true,
        vcs: false,
      },
    });
  });

  it('accepts -c for --configuration and -h for help', () => {
    expect(parseArgs(['-c', 'staging'])).toEqual({ options: { configuration: 'staging' } });
    expect(parseArgs(['-h'])).toEqual({ options: {}, help: true });
    expect(parseArgs(['--help'])).toEqual({ options: {}, help: true });
  });

  it('returns nothing for no arguments', () => {
    expect(parseArgs([])).toEqual({ options: {} });
  });

  it('rejects an unknown flag, a missing value and a stray argument', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option "--nope"/);
    expect(() => parseArgs(['--project'])).toThrow(/--project needs a value/);
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow(/--project needs a value/);
    expect(() => parseArgs(['stray'])).toThrow(/unexpected argument "stray"/);
    expect(() => parseArgs(['--dry-run=yes'])).toThrow(/--dry-run does not take a value/);
  });

  it('does not take the token on the command line', () => {
    expect(() => parseArgs(['--app-token', 'x'])).toThrow(/BUGSEE_APP_TOKEN/);
  });
});

describe('runCli', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        cwd: '/ws',
        env: { BUGSEE_APP_TOKEN: 'tok' },
        stdout: (m: string) => out.push(m),
        stderr: (m: string) => err.push(m),
      },
    };
  };
  const uploaded = (over: Partial<AngularUploadResult> = {}) =>
    vi.fn(
      async (_o: AngularUploadOptions): Promise<AngularUploadResult> => ({
        status: 'uploaded',
        outDir: '/ws/dist/demo/browser',
        configuration: 'production',
        result: { injected: true, uploaded: true, deletedMaps: ['a.map', 'b.map'] },
        ...over,
      }),
    );

  it('prints the help and does not upload', async () => {
    const { io: i, out } = io();
    const upload = uploaded();
    expect(await runCli(['--help'], i, upload)).toBe(0);
    expect(out.join('')).toBe(HELP);
    expect(upload).not.toHaveBeenCalled();
  });

  it('hands the parsed options, the working directory and the environment to the upload', async () => {
    const { io: i } = io();
    const upload = uploaded();
    await runCli(['--project', 'demo', '--dry-run'], i, upload);
    expect(upload).toHaveBeenCalledWith({
      project: 'demo',
      dryRun: true,
      cwd: '/ws',
      env: { BUGSEE_APP_TOKEN: 'tok' },
    });
  });

  it('reports what was uploaded and how many maps were removed', async () => {
    const { io: i, out } = io();
    expect(await runCli([], i, uploaded())).toBe(0);
    expect(out.join('')).toContain('uploaded the source maps of /ws/dist/demo/browser');
    expect(out.join('')).toContain('removed 2 local map(s)');
  });

  it('reports a dry run as checked, and a kept-maps upload without a removal count', async () => {
    const { io: i, out } = io();
    await runCli(
      ['--dry-run'],
      i,
      uploaded({ result: { injected: true, uploaded: false, deletedMaps: [] } }),
    );
    expect(out.join('')).toContain('dry run: checked the source maps');
    expect(out.join('')).not.toContain('uploaded the source maps');
    const kept = io();
    await runCli(
      ['--keep-maps'],
      kept.io,
      uploaded({ result: { injected: true, uploaded: true, deletedMaps: [] } }),
    );
    expect(kept.out.join('')).toBe('[bugsee] uploaded the source maps of /ws/dist/demo/browser.\n');
  });

  it('says the upload did not complete when the pipeline contained a failure (already reported)', async () => {
    const { io: i, out, err } = io();
    expect(
      await runCli(
        [],
        i,
        uploaded({ result: { injected: false, uploaded: false, deletedMaps: [] } }),
      ),
    ).toBe(0);
    expect(out.join('')).toBe('');
    expect(err.join('')).toContain('did not complete');
  });

  it('is quiet for a skipped, disabled or refused run, whose notice was already printed', async () => {
    for (const status of ['skipped', 'disabled', 'refused'] as const) {
      const { io: i, out, err } = io();
      const { result: _drop, ...rest } = (await uploaded()({})) as AngularUploadResult;
      expect(
        await runCli(
          [],
          i,
          vi.fn(async () => ({ ...rest, status })),
        ),
      ).toBe(0);
      expect(out.join('') + err.join('')).toBe('');
    }
  });

  it('exits 1 with the message on an error', async () => {
    const { io: i, err } = io();
    const upload = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await runCli([], i, upload)).toBe(1);
    expect(err.join('')).toContain('[bugsee] boom');
  });

  it('exits 2 on a usage error, with the help hint', async () => {
    const { io: i, err } = io();
    expect(await runCli(['--nope'], i, uploaded())).toBe(2);
    expect(err.join('')).toContain('unknown option');
    expect(err.join('')).toContain('--help');
  });

  it('reports a non-Error throw', async () => {
    const { io: i, err } = io();
    const upload = vi.fn(async () => {
      throw 'plain';
    });
    expect(await runCli([], i, upload)).toBe(1);
    expect(err.join('')).toContain('plain');
  });
});
