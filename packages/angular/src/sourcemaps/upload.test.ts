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

  it("names this build's own files, so foreign files under fenced directories are never deleted", async () => {
    await builtApp();
    await write('dist/demo/browser/assets/img/logo.png', 'x');
    await write('dist/demo/browser/node_modules/p/v.js.map', '{}');
    await write('dist/demo/browser/src/a.js.map', '{}');
    await write('dist/demo/browser/test/t.js.map', '{}');
    await write('dist/demo/browser/.cache/c.js.map', '{}');
    const runPluginUpload = ran();
    await uploadAngularSourcemaps(base({ cwd }), { runPluginUpload });
    const own = (runPluginUpload.mock.calls[0]?.[2] as { ownFiles?: string[] }).ownFiles?.sort();
    expect(own).toEqual(
      ['assets/img/logo.png', 'index.html', 'main-ABC.js', 'main-ABC.js.map'].sort(),
    );
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

  it('--dist on an SSR build re-seals the whole output root: the server modules embed the page', async () => {
    await write('custom/app/browser/main.js', 'x();');
    await write('custom/app/browser/main.js.map', '{}');
    await write('custom/app/server/server.mjs', '');
    const runPluginUpload = ran();
    await uploadAngularSourcemaps(base({ cwd, dist: 'custom/app/browser' }), { runPluginUpload });
    expect(runPluginUpload.mock.calls[0]?.[2]).toMatchObject({
      resealDirs: [join(cwd, 'custom', 'app')],
    });
  });

  it('--dist: a sibling server/ outside the project is not pulled in', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'bugsee-ng-out-'));
    try {
      await mkdir(join(outside, 'browser'), { recursive: true });
      await mkdir(join(outside, 'server'));
      await writeFile(join(outside, 'browser', 'main.js'), 'x();');
      const runPluginUpload = ran();
      await uploadAngularSourcemaps(base({ cwd, dist: join(outside, 'browser') }), {
        runPluginUpload,
      });
      expect(runPluginUpload.mock.calls[0]?.[2]).toMatchObject({
        resealDirs: [join(outside, 'browser')],
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('--dist directly under the project root never re-seals the project root', async () => {
    await write('browser/main.js', 'x();');
    await write('server/server.mjs', '');
    const runPluginUpload = ran();
    await uploadAngularSourcemaps(base({ cwd, dist: 'browser' }), { runPluginUpload });
    expect(runPluginUpload.mock.calls[0]?.[2]).toMatchObject({
      resealDirs: [join(cwd, 'browser')],
    });
  });

  it('--dist whose sibling is not named server/ stays browser-only', async () => {
    await write('x/browser/main.js', 'x();');
    await write('x/other/a.mjs', '');
    const runPluginUpload = ran();
    await uploadAngularSourcemaps(base({ cwd, dist: 'x/browser' }), { runPluginUpload });
    expect(runPluginUpload.mock.calls[0]?.[2]).toMatchObject({
      resealDirs: [join(cwd, 'x', 'browser')],
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

  it('is a no-op without a token even where the output cannot be located (a contributor build with no secret)', async () => {
    const notices: string[] = [];
    // No angular.json at all.
    const none = await uploadAngularSourcemaps(
      { cwd, vcs: false, env: {}, onNotice: (m) => notices.push(m) },
      { runPluginUpload: ran() },
    );
    expect(none.status).toBe('disabled');
    // Several applications and no --project.
    await write(
      'angular.json',
      JSON.stringify({
        projects: {
          one: { projectType: 'application', root: '', architect: { build: {} } },
          two: { projectType: 'application', root: '', architect: { build: {} } },
        },
      }),
    );
    const several = await uploadAngularSourcemaps(
      { cwd, vcs: false, env: {}, onNotice: (m) => notices.push(m) },
      { runPluginUpload: ran() },
    );
    expect(several.status).toBe('disabled');
    expect(notices.filter((m) => m.includes('BUGSEE_APP_TOKEN'))).toHaveLength(2);
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

  describe('a build whose output cannot be found', () => {
    const noDist = async () =>
      write(
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
    const run = (extra: Record<string, unknown>, notices: string[] = []) =>
      uploadAngularSourcemaps(base({ cwd, onNotice: (m: string) => notices.push(m), ...extra }), {
        runPluginUpload: ran(),
      });

    it('missing output directory: says which build to run and how to point at another, exits cleanly', async () => {
      await noDist();
      const notices: string[] = [];
      const out = await run({}, notices);
      expect(out.status).toBe('misconfigured');
      expect(notices.join('\n')).toMatch(
        /dist.*demo.*browser.*ng build.*--output-path.*Nothing was uploaded/s,
      );
    });

    it('no angular.json, several applications, an unparseable angular.json: each said, none thrown', async () => {
      const notices: string[] = [];
      expect((await run({}, notices)).status).toBe('misconfigured');
      await write(
        'angular.json',
        JSON.stringify({
          projects: {
            one: { projectType: 'application', root: '', architect: { build: {} } },
            two: { projectType: 'application', root: '', architect: { build: {} } },
          },
        }),
      );
      expect((await run({}, notices)).status).toBe('misconfigured');
      await write('angular.json', '{ nope');
      expect((await run({}, notices)).status).toBe('misconfigured');
      expect(notices).toHaveLength(3);
      expect(notices[0]).toMatch(/--output-path/);
    });

    it('under failOnError each of them throws', async () => {
      await expect(run({ failOnError: true })).rejects.toThrow(/angular\.json/);
      await noDist();
      await expect(run({ failOnError: true })).rejects.toThrow(/ng build/);
    });

    it('outputPath { browser: "" } on an SSR build (server/ inside the browser directory) is refused: it would stamp the server', async () => {
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
                  options: { outputPath: { base: 'dist/app', browser: '' } },
                },
              },
            },
          },
        }),
      );
      await write('dist/app/main.js', 'x();');
      await write('dist/app/server/server.mjs', '');
      const runPluginUpload = ran();
      const notices: string[] = [];
      const out = await uploadAngularSourcemaps(
        base({ cwd, onNotice: (m: string) => notices.push(m) }),
        { runPluginUpload },
      );
      expect(out.status).toBe('misconfigured');
      expect(runPluginUpload).not.toHaveBeenCalled();
      expect(notices.join('\n')).toMatch(/server.*inside.*browser/s);
    });

    it('the same layout WITHOUT a server output is fine', async () => {
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
                  options: { outputPath: { base: 'dist/app', browser: '' } },
                },
              },
            },
          },
        }),
      );
      await write('dist/app/main.js', 'x();');
      await write('dist/app/main.js.map', '{}');
      const out = await uploadAngularSourcemaps(base({ cwd }), { runPluginUpload: ran() });
      expect(out.status).toBe('uploaded');
    });

    it('--dist naming a FILE is a misconfiguration said, not a crash', async () => {
      await write('a-file', 'x');
      const notices: string[] = [];
      const out = await run({ dist: 'a-file' }, notices);
      expect(out.status).toBe('misconfigured');
      expect(notices.join('\n')).toMatch(/not a directory/);
    });

    it('--output-path <base> of a custom-browser build (client/ beside server/) is refused: it would stamp the server', async () => {
      await write('o/client/main.js', 'x();');
      await write('o/server/server.mjs', '');
      const runPluginUpload = ran();
      const notices: string[] = [];
      const out = await uploadAngularSourcemaps(
        base({ cwd, outputPath: 'o', onNotice: (m: string) => notices.push(m) }),
        { runPluginUpload },
      );
      expect(out.status).toBe('misconfigured');
      expect(runPluginUpload).not.toHaveBeenCalled();
      expect(notices.join('\n')).toMatch(/--dist/);
    });

    it('the project root as output root with SRI pins in the browser pages is refused: the server copies cannot be re-sealed', async () => {
      await write('browser/main.js', 'x();');
      await write('browser/index.html', '<script src="main.js" integrity="sha384-AAAA"></script>');
      await write('server/server.mjs', '');
      const runPluginUpload = ran();
      const out = await uploadAngularSourcemaps(base({ cwd, dist: 'browser' }), {
        runPluginUpload,
      });
      expect(out.status).toBe('misconfigured');
      expect(runPluginUpload).not.toHaveBeenCalled();
    });

    it('the project root as output root WITHOUT pins is only said, and still uploads', async () => {
      await write('browser/main.js', 'x();');
      await write('server/server.mjs', '');
      const runPluginUpload = ran();
      const notices: string[] = [];
      const out = await uploadAngularSourcemaps(
        base({ cwd, dist: 'browser', onNotice: (m: string) => notices.push(m) }),
        { runPluginUpload },
      );
      expect(out.status).toBe('uploaded');
      expect(notices.join('\n')).toMatch(/project root/);
    });

    it('--output-path points at the base of an application build, and at a flat one', async () => {
      await write('moved/browser/main.js', 'x();');
      await write('moved/browser/main.js.map', '{}');
      await write('moved/server/server.mjs', '');
      await write('flat/main.js', 'x();');
      await write('flat/main.js.map', '{}');
      const runPluginUpload = ran();
      const a = await uploadAngularSourcemaps(base({ cwd, outputPath: 'moved' }), {
        runPluginUpload,
      });
      expect(a.outDir).toBe(join(cwd, 'moved', 'browser'));
      expect(runPluginUpload.mock.calls[0]?.[2]).toMatchObject({
        resealDirs: [join(cwd, 'moved')],
      });
      const b = await uploadAngularSourcemaps(base({ cwd, outputPath: 'flat' }), {
        runPluginUpload,
      });
      expect(b.outDir).toBe(join(cwd, 'flat'));
      expect(runPluginUpload.mock.calls[1]?.[2]).toMatchObject({ resealDirs: [join(cwd, 'flat')] });
    });

    it('--output-path that does not exist is misconfigured too, and a tokenless run still no-ops', async () => {
      const out = await run({ outputPath: 'nowhere' });
      expect(out.status).toBe('misconfigured');
      const none = await uploadAngularSourcemaps(
        { cwd, vcs: false, env: {}, outputPath: 'nowhere', onNotice: () => undefined },
        { runPluginUpload: ran() },
      );
      expect(none).toMatchObject({ status: 'disabled', outDir: join(cwd, 'nowhere') });
    });
  });

  it('stamps a build with service worker manifests, one per locale: it re-computes them, it does not refuse', async () => {
    await builtApp({ ngsw: true });
    await write('dist/demo/browser/fr/ngsw.json', '{}');
    const runPluginUpload = ran();
    const notices: string[] = [];
    const out = await uploadAngularSourcemaps(
      base({ cwd, onNotice: (m: string) => notices.push(m) }),
      { runPluginUpload },
    );
    expect(out.status).toBe('uploaded');
    expect(runPluginUpload).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
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
