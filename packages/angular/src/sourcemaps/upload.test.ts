import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadAngularSourcemaps } from './upload';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'bugsee-ng-up-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const write = async (rel: string, body = '') => {
  const full = join(cwd, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body);
};

/** A workspace with an esbuild `application` project that has been built (with a map). */
const builtApp = async (
  opts: { ssr?: boolean; map?: boolean; ngsw?: boolean; config?: string } = {},
) => {
  await write(
    'angular.json',
    JSON.stringify({
      projects: {
        demo: {
          projectType: 'application',
          root: '',
          architect: {
            build: {
              builder: '@angular/build:application',
              options: {},
              configurations: { production: {}, development: {} },
              defaultConfiguration: opts.config ?? 'production',
            },
          },
        },
      },
    }),
  );
  await write('dist/demo/browser/index.html', '<html></html>');
  await write('dist/demo/browser/main-ABC.js', 'x();');
  if (opts.map !== false) {
    await write('dist/demo/browser/main-ABC.js.map', '{}');
  }
  if (opts.ssr) {
    await write('dist/demo/server/server.mjs', '');
  }
  if (opts.ngsw) {
    await write('dist/demo/browser/ngsw.json', '{}');
  }
};

const ran = (result: Record<string, unknown> = {}) =>
  vi.fn(async (_resolved: unknown, _dir: string, _deps: Record<string, unknown>) => ({
    injected: true,
    uploaded: true,
    deletedMaps: [],
    ...result,
  }));

const base = (extra: Record<string, unknown> = {}) => ({
  appToken: 'tok',
  appVersion: '1.2.3',
  appBuild: '9',
  vcs: false,
  env: {},
  ...extra,
});

describe('uploadAngularSourcemaps', () => {
  it('uploads the browser directory, stamping through the re-seal path', async () => {
    await builtApp();
    const runPluginUpload = ran();
    const notices: string[] = [];
    const out = await uploadAngularSourcemaps(
      base({ cwd, onNotice: (m: string) => notices.push(m) }),
      {
        runPluginUpload,
      },
    );
    expect(out.status).toBe('uploaded');
    expect(out.outDir).toBe(join(cwd, 'dist', 'demo', 'browser'));
    const [resolved, dir, deps] = runPluginUpload.mock.calls[0] as [
      Record<string, unknown>,
      string,
      Record<string, unknown>,
    ];
    expect(dir).toBe(join(cwd, 'dist', 'demo', 'browser'));
    expect(resolved).toMatchObject({
      appToken: 'tok',
      appVersion: '1.2.3',
      appBuild: '9',
      projectRoot: cwd,
      enabled: true,
    });
    expect(deps).toMatchObject({
      resealSri: true,
      resealDirs: [join(cwd, 'dist', 'demo', 'browser')],
      bundler: { isProduction: true, configuration: 'production' },
    });
    expect(notices).toEqual([]);
  });

  it('re-seals across the whole output root when the build has a server, which embeds the page', async () => {
    await builtApp({ ssr: true });
    const runPluginUpload = ran();
    await uploadAngularSourcemaps(base({ cwd }), { runPluginUpload });
    expect(runPluginUpload.mock.calls[0]?.[2]).toMatchObject({
      resealDirs: [join(cwd, 'dist', 'demo')],
    });
  });

  it('takes the directory from --dist and ignores angular.json', async () => {
    await write('out/main.js', 'x();');
    await write('out/main.js.map', '{}');
    const runPluginUpload = ran();
    const out = await uploadAngularSourcemaps(base({ cwd, dist: 'out' }), { runPluginUpload });
    expect(out.outDir).toBe(join(cwd, 'out'));
    expect(runPluginUpload.mock.calls[0]?.[2]).toMatchObject({
      resealDirs: [join(cwd, 'out')],
      bundler: { isProduction: true },
    });
  });

  it('reads the token and version from the environment and the env file, like the bundler plugins', async () => {
    await builtApp();
    await write('.env.bugsee-build-plugin', 'BUGSEE_APP_TOKEN=from-file\n');
    const runPluginUpload = ran();
    await uploadAngularSourcemaps(
      { cwd, vcs: false, env: { BUGSEE_APP_VERSION: '4.5.6' } },
      { runPluginUpload },
    );
    expect(runPluginUpload.mock.calls[0]?.[0]).toMatchObject({
      appToken: 'from-file',
      appVersion: '4.5.6',
    });
  });

  it('reports a problem with the env file once, through onNotice', async () => {
    await builtApp();
    await write('.env.bugsee-build-plugin', '￾');
    const notices: string[] = [];
    await uploadAngularSourcemaps(base({ cwd, onNotice: (m: string) => notices.push(m) }), {
      runPluginUpload: ran(),
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^\[bugsee\] /);
  });

  it('does nothing, and says so, without a token', async () => {
    await builtApp();
    const runPluginUpload = ran();
    const notices: string[] = [];
    const out = await uploadAngularSourcemaps(
      { cwd, vcs: false, env: {}, onNotice: (m) => notices.push(m) },
      { runPluginUpload },
    );
    expect(out.status).toBe('disabled');
    expect(runPluginUpload).not.toHaveBeenCalled();
    expect(notices.join('\n')).toContain('BUGSEE_APP_TOKEN');
  });

  it('is silent when disabled on purpose', async () => {
    await builtApp();
    const notices: string[] = [];
    const out = await uploadAngularSourcemaps(
      base({ cwd, disabled: true, onNotice: (m: string) => notices.push(m) }),
      {
        runPluginUpload: ran(),
      },
    );
    expect(out.status).toBe('disabled');
    expect(notices).toEqual([]);
  });

  it('fails when the build output is not there, saying which build to run', async () => {
    await write(
      'angular.json',
      JSON.stringify({
        projects: {
          demo: {
            projectType: 'application',
            root: '',
            architect: { build: { builder: '@angular/build:application' } },
          },
        },
      }),
    );
    await expect(
      uploadAngularSourcemaps(base({ cwd }), { runPluginUpload: ran() }),
    ).rejects.toThrow(/dist.*demo.*browser.*ng build/);
  });

  it('refuses a build with a service worker manifest, which pins a hash of every file', async () => {
    await builtApp({ ngsw: true });
    const runPluginUpload = ran();
    const notices: string[] = [];
    const out = await uploadAngularSourcemaps(
      base({ cwd, onNotice: (m: string) => notices.push(m) }),
      {
        runPluginUpload,
      },
    );
    expect(out.status).toBe('refused');
    expect(runPluginUpload).not.toHaveBeenCalled();
    expect(notices.join('\n')).toMatch(/ngsw\.json/);
  });

  it('throws that refusal under failOnError', async () => {
    await builtApp({ ngsw: true });
    await expect(
      uploadAngularSourcemaps(base({ cwd, failOnError: true }), { runPluginUpload: ran() }),
    ).rejects.toThrow(/ngsw\.json/);
  });

  it('says so when the build has no source maps, and still runs (the CLI tolerates an empty directory)', async () => {
    await builtApp({ map: false });
    const runPluginUpload = ran();
    const notices: string[] = [];
    await uploadAngularSourcemaps(base({ cwd, onNotice: (m: string) => notices.push(m) }), {
      runPluginUpload,
    });
    expect(notices.join('\n')).toMatch(/no source maps.*sourceMap/s);
    expect(runPluginUpload).toHaveBeenCalledTimes(1);
  });

  it('finds a source map in a subdirectory, but not inside node_modules', async () => {
    await builtApp({ map: false });
    await write('dist/demo/browser/assets/x.js.map', '{}');
    await write('dist/demo/browser/node_modules/y/z.js.map', '{}');
    const notices: string[] = [];
    await uploadAngularSourcemaps(base({ cwd, onNotice: (m: string) => notices.push(m) }), {
      runPluginUpload: ran(),
    });
    expect(notices).toEqual([]);
    await rm(join(cwd, 'dist/demo/browser/assets'), { recursive: true });
    await uploadAngularSourcemaps(base({ cwd, onNotice: (m: string) => notices.push(m) }), {
      runPluginUpload: ran(),
    });
    expect(notices.join('\n')).toMatch(/no source maps/);
  });

  it('skips a development configuration unless asked, as the other plugins do', async () => {
    await builtApp({ config: 'development' });
    const runPluginUpload = ran();
    const notices: string[] = [];
    const out = await uploadAngularSourcemaps(
      base({ cwd, onNotice: (m: string) => notices.push(m) }),
      {
        runPluginUpload,
      },
    );
    expect(out.status).toBe('skipped');
    expect(runPluginUpload).not.toHaveBeenCalled();
    expect(notices.join('\n')).toMatch(/development/);
    const forced = await uploadAngularSourcemaps(base({ cwd, uploadInDevelopment: true }), {
      runPluginUpload,
    });
    expect(forced.status).toBe('uploaded');
    expect(runPluginUpload.mock.calls[0]?.[2]).toMatchObject({ bundler: { isProduction: false } });
  });

  it('passes the project and configuration to the output lookup', async () => {
    await builtApp();
    const out = await uploadAngularSourcemaps(
      base({ cwd, project: 'demo', configuration: 'development', uploadInDevelopment: true }),
      {
        runPluginUpload: ran(),
      },
    );
    expect(out.configuration).toBe('development');
  });

  it('returns what the upload reported', async () => {
    await builtApp();
    const out = await uploadAngularSourcemaps(base({ cwd }), {
      runPluginUpload: ran({ uploaded: false, injected: false }),
    });
    expect(out.status).toBe('uploaded');
    expect(out.result).toMatchObject({ uploaded: false, injected: false });
  });

  it('defaults the working directory to the process one, and the environment to process.env', async () => {
    await builtApp();
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      const runPluginUpload = ran();
      await uploadAngularSourcemaps({ vcs: false, appToken: 'tok' }, { runPluginUpload });
      expect(runPluginUpload.mock.calls[0]?.[1]).toBe(join(cwd, 'dist', 'demo', 'browser'));
    } finally {
      spy.mockRestore();
    }
  });

  it('does not look for source maps deeper than a build writes them', async () => {
    await builtApp({ map: false });
    await write('dist/demo/browser/a/b/c/d/deep.js.map', '{}');
    const notices: string[] = [];
    await uploadAngularSourcemaps(base({ cwd, onNotice: (m: string) => notices.push(m) }), {
      runPluginUpload: ran(),
    });
    expect(notices.join('\n')).toMatch(/no source maps/);
  });

  it('prints notices through console.warn when no sink is given', async () => {
    await builtApp({ map: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await uploadAngularSourcemaps(base({ cwd }), { runPluginUpload: ran() });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[bugsee\] no source maps/));
    } finally {
      warn.mockRestore();
    }
  });
});
