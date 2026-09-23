import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveBuildUuid } from './build-id';
import {
  findPackageName,
  type RegisterJsBuildOptions,
  registerJsBuild,
  resolveRegistration,
} from './register-build';
import type { RunBugseeCliOptions } from './run-cli';

const ID_A = '0f3c2a1e-7b1d-5e2a-9c4b-1a2b3c4d5e6f';

describe('resolveRegistration', () => {
  // D2: the bundler's OWN production signal is the analog of AGP's `isDebuggable` — not
  // minification, and not a guess from the output directory's name.
  it('registers a production build by default', () => {
    expect(resolveRegistration('release', { isProduction: true }, {})).toEqual({ register: true });
  });

  it('does not register a development build by default', () => {
    expect(resolveRegistration('release', { isProduction: false }, {})).toEqual({
      register: false,
      reason: 'not-release',
    });
  });

  it("prefers the bundler's signal over NODE_ENV", () => {
    // `vite build --mode staging` is a production build whose NODE_ENV the user may never have set.
    expect(
      resolveRegistration('release', { isProduction: true }, { NODE_ENV: 'development' }),
    ).toEqual({ register: true });
    expect(
      resolveRegistration('release', { isProduction: false }, { NODE_ENV: 'production' }),
    ).toEqual({ register: false, reason: 'not-release' });
  });

  it('falls back to NODE_ENV for a bundler with no production signal', () => {
    // Rollup has no mode; NODE_ENV is the convention its users follow.
    expect(resolveRegistration('release', {}, { NODE_ENV: 'production' })).toEqual({
      register: true,
    });
    expect(resolveRegistration('release', {}, { NODE_ENV: 'test' })).toEqual({
      register: false,
      reason: 'not-release',
    });
    expect(resolveRegistration('release', {}, {})).toEqual({
      register: false,
      reason: 'not-release',
    });
  });

  it("'always' registers every build, release or not", () => {
    expect(resolveRegistration('always', { isProduction: false }, {})).toEqual({ register: true });
  });

  it('false registers nothing, even a release build', () => {
    expect(resolveRegistration(false, { isProduction: true }, {})).toEqual({
      register: false,
      reason: 'disabled',
    });
  });
});

describe('findPackageName', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bugsee-pkg-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads the name from the nearest package.json, scope included (D3)', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@acme/web-app' }));
    expect(await findPackageName(root)).toBe('@acme/web-app');
  });

  it('walks up from a nested project directory', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@acme/web-app' }));
    await mkdir(join(root, 'apps', 'site'), { recursive: true });
    expect(await findPackageName(join(root, 'apps', 'site'))).toBe('@acme/web-app');
  });

  it('stops at the NEAREST package.json, so a monorepo app is not named after its workspace', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo-root' }));
    await mkdir(join(root, 'apps', 'site'), { recursive: true });
    await writeFile(join(root, 'apps', 'site', 'package.json'), JSON.stringify({ name: 'site' }));
    expect(await findPackageName(join(root, 'apps', 'site'))).toBe('site');
  });

  it('skips a package.json that has no usable name', async () => {
    // A workspace root is often `"private": true` with no name at all.
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@acme/web-app' }));
    await mkdir(join(root, 'apps'));
    await writeFile(join(root, 'apps', 'package.json'), JSON.stringify({ private: true }));
    await writeFile(join(root, 'apps', 'empty.json'), '');
    expect(await findPackageName(join(root, 'apps'))).toBe('@acme/web-app');
  });

  it('skips a package.json that is not valid JSON rather than failing', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'outer' }));
    await mkdir(join(root, 'inner'));
    await writeFile(join(root, 'inner', 'package.json'), '{ not json');
    expect(await findPackageName(join(root, 'inner'))).toBe('outer');
  });

  it('returns nothing when no ancestor has a named package.json', async () => {
    // Bounded at `root` so the result does not depend on whatever sits above the temp directory on
    // the machine running the test. Starts from a directory that does not exist: must not throw.
    expect(await findPackageName(join(root, 'no', 'such', 'dir'), root)).toBeTypeOf('undefined');
  });

  it('does not look above the boundary', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'outside' }));
    await mkdir(join(root, 'inner'));
    expect(await findPackageName(join(root, 'inner'), join(root, 'inner'))).toBeTypeOf('undefined');
  });
});

describe('registerJsBuild', () => {
  type Call = { args: string[]; options: RunBugseeCliOptions; payload?: unknown };
  let calls: Call[];

  const recordingRun = (): RegisterJsBuildOptions['run'] =>
    vi.fn(async (args: string[], options: RunBugseeCliOptions) => {
      const at = args.indexOf('--payload-json');
      // Read the payload WHILE the CLI would be reading it — it is cleaned up afterwards.
      const payload =
        at === -1 ? undefined : JSON.parse(await readFile(args[at + 1] as string, 'utf8'));
      calls.push({ args, options, payload });
      return { code: 0, stdout: 'build-123\n', stderr: '' };
    });

  const base = (over: Partial<RegisterJsBuildOptions> = {}): RegisterJsBuildOptions => ({
    outDir: '/out',
    appToken: 'tok',
    appVersion: '1.4.0',
    appBuild: '42',
    setting: 'release',
    bundler: { isProduction: true, configuration: 'production' },
    env: {},
    projectRoot: '/proj',
    run: recordingRun(),
    collectDebugIds: async () => [ID_A],
    findPackageName: async () => '@acme/web-app',
    ...over,
  });

  beforeEach(() => {
    calls = [];
  });

  it('registers through `upload build` with no artefact', async () => {
    const result = await registerJsBuild(base());

    expect(calls).toHaveLength(1);
    const [call] = calls as [Call];
    expect(call.args.slice(0, 2)).toEqual(['upload', 'build']);
    // D5: register-only. No `--artifact`, so the CLI sends `request_artifact_upload: false` itself;
    // the flags that only describe artefact bytes would be refused without one.
    for (const flag of ['--artifact', '--mapping', '--chunked', '--out']) {
      expect(call.args).not.toContain(flag);
    }
    expect(result).toMatchObject({ registered: true, dryRun: false });
  });

  it('sends the JavaScript-build payload', async () => {
    await registerJsBuild(base());

    expect(calls[0]?.payload).toEqual({
      uuid: deriveBuildUuid([ID_A], {
        packageId: '@acme/web-app',
        version: '1.4.0',
        build: '42',
        configuration: 'production',
      }),
      format: 'js',
      package_id: '@acme/web-app',
      version: '1.4.0',
      build: '42',
      build_configuration: 'production',
    });
  });

  it('names the format `js` — the artefact, not a runtime', async () => {
    // This one plugin registers browser bundles, SSR server bundles, edge workers, bundled Node
    // services and Electron's main process alike. `web` (its first name, briefly accepted by
    // bugsee-appserver#42) described only the first; the runtime lives on the application.
    await registerJsBuild(base());
    expect((calls[0]?.payload as { format: string }).format).toBe('js');
  });

  it('never puts the app token in the payload file or on argv', async () => {
    // The payload lands on disk in a temp directory; the token belongs in the child's environment.
    await registerJsBuild(base({ appToken: 'secret-token' }));

    expect(JSON.stringify(calls[0]?.payload)).not.toContain('secret-token');
    expect(calls[0]?.args).not.toContain('secret-token');
    expect(calls[0]?.options.token).toBe('secret-token');
  });

  it('forwards the endpoint the source-map upload uses', async () => {
    await registerJsBuild(base({ endpoint: 'https://apidev.bugsee.com' }));
    expect(calls[0]?.options.endpoint).toBe('https://apidev.bugsee.com');
  });

  it('carries the VCS metadata the plugin already collected', async () => {
    const vcs = { provider: 'github', commit_sha: 'a'.repeat(40), branch: 'main' };
    await registerJsBuild(base({ vcs }));
    expect((calls[0]?.payload as { vcs: unknown }).vcs).toEqual(vcs);
  });

  it('omits what it does not know rather than sending it empty', async () => {
    // Absence is how the backend tells "unknown" from "known empty".
    await registerJsBuild(
      base({ findPackageName: async () => undefined, bundler: { isProduction: true } }),
    );
    const payload = calls[0]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('package_id');
    expect(payload).not.toHaveProperty('vcs');
    expect(payload).not.toHaveProperty('build_configuration');
  });

  it('omits an EMPTY configuration too — an empty NODE_ENV names nothing', async () => {
    await registerJsBuild(base({ bundler: { isProduction: true }, env: { NODE_ENV: '' } }));
    expect(calls[0]?.payload as Record<string, unknown>).not.toHaveProperty('build_configuration');
  });

  it('prefers an explicit package id over package.json', async () => {
    const findPackageName = vi.fn(async () => '@acme/web-app');
    await registerJsBuild(base({ packageId: 'com.acme.web', findPackageName }));
    expect((calls[0]?.payload as { package_id: string }).package_id).toBe('com.acme.web');
    expect(findPackageName).not.toHaveBeenCalled();
  });

  it('looks for package.json from the project root', async () => {
    const findPackageName = vi.fn(async () => 'x');
    await registerJsBuild(base({ projectRoot: '/proj/apps/site', findPackageName }));
    expect(findPackageName).toHaveBeenCalledWith('/proj/apps/site');
  });

  it('reads the debug-ids from the output directory', async () => {
    const collectDebugIds = vi.fn(async () => [ID_A]);
    await registerJsBuild(base({ outDir: '/out/dist', collectDebugIds }));
    expect(collectDebugIds).toHaveBeenCalledWith('/out/dist');
  });

  it('falls back to NODE_ENV as the configuration when the bundler names none', async () => {
    await registerJsBuild(base({ bundler: {}, env: { NODE_ENV: 'production' } }));
    expect((calls[0]?.payload as { build_configuration: string }).build_configuration).toBe(
      'production',
    );
  });

  it('passes --dry-run through, and reports it', async () => {
    const result = await registerJsBuild(base({ dryRun: true }));
    expect(calls[0]?.args).toContain('--dry-run');
    expect(result).toMatchObject({ registered: true, dryRun: true });
  });

  it('skips a non-release build without touching the CLI', async () => {
    const run = recordingRun();
    const collectDebugIds = vi.fn(async () => [ID_A]);
    const result = await registerJsBuild(
      base({ bundler: { isProduction: false }, run, collectDebugIds }),
    );
    expect(result).toEqual({ registered: false, reason: 'not-release' });
    expect(run).not.toHaveBeenCalled();
    // Nothing else is done either: a skipped registration reads no files at all.
    expect(collectDebugIds).not.toHaveBeenCalled();
  });

  it('skips entirely when disabled', async () => {
    const run = recordingRun();
    expect(await registerJsBuild(base({ setting: false, run }))).toEqual({
      registered: false,
      reason: 'disabled',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses an empty token outright, like the source-map upload', async () => {
    await expect(registerJsBuild(base({ appToken: '' }))).rejects.toThrow(/appToken/);
  });

  describe('a failure (D4 — never fails the build by default)', () => {
    const failingRun = (): RegisterJsBuildOptions['run'] =>
      vi.fn(async () => {
        throw new Error('bugsee-cli exited 30: server said no');
      });

    it('is reported and contained', async () => {
      const onError = vi.fn();
      const result = await registerJsBuild(base({ run: failingRun(), onError }));
      expect(result).toEqual({ registered: false, reason: 'failed' });
      expect(onError).toHaveBeenCalledOnce();
      expect(String(onError.mock.calls[0]?.[0])).toMatch(/server said no/);
    });

    it('rethrows under failOnError', async () => {
      await expect(registerJsBuild(base({ run: failingRun(), failOnError: true }))).rejects.toThrow(
        /server said no/,
      );
    });

    it('warns on the console, naming the step, when no handler is given', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await registerJsBuild(base({ run: failingRun() }));
        expect(warn).toHaveBeenCalledOnce();
        // Distinct from the source-map upload's own message, so the log says WHICH step failed.
        expect(String(warn.mock.calls[0]?.[0])).toMatch(/\[bugsee\] build registration skipped/);
      } finally {
        warn.mockRestore();
      }
    });

    it('is contained even when collecting context throws', async () => {
      const onError = vi.fn();
      const result = await registerJsBuild(
        base({
          collectDebugIds: async () => {
            throw new Error('EACCES');
          },
          onError,
        }),
      );
      expect(result).toEqual({ registered: false, reason: 'failed' });
      expect(onError).toHaveBeenCalledOnce();
    });
  });

  it('removes the payload file afterwards, on success and on failure', async () => {
    const seen: string[] = [];
    const run: RegisterJsBuildOptions['run'] = async (args) => {
      seen.push(args[args.indexOf('--payload-json') + 1] as string);
      if (seen.length === 2) {
        throw new Error('boom');
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    await registerJsBuild(base({ run }));
    await registerJsBuild(base({ run, onError: () => undefined }));

    expect(seen).toHaveLength(2);
    for (const path of seen) {
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  describe('with its real defaults — no seam injected', () => {
    // Every other test injects the file walk, the package.json lookup and the CLI runner. This one
    // injects none of them, so what ships is what runs: a real directory, a real package.json above it,
    // and a real child process (a stand-in binary, found the way the real one is — BUGSEE_CLI_PATH).
    let root: string;
    const saved = process.env.BUGSEE_CLI_PATH;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'bugsee-reg-defaults-'));
    });
    afterEach(async () => {
      if (saved === undefined) {
        delete process.env.BUGSEE_CLI_PATH;
      } else {
        process.env.BUGSEE_CLI_PATH = saved;
      }
      await rm(root, { recursive: true, force: true });
    });

    it('finds the ids, names the package and spawns the CLI', async () => {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@acme/defaults' }));
      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'dist', 'app.js'), `x();\n//# debugId=${ID_A}\n`);
      const log = join(root, 'argv.json');
      const cli = join(root, 'fake-cli.mjs');
      await writeFile(
        cli,
        `#!/usr/bin/env node\nimport { writeFileSync, readFileSync } from 'node:fs';\n` +
          `const argv = process.argv.slice(2);\n` +
          `writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, payload: JSON.parse(readFileSync(argv[3], 'utf8')) }));\n`,
      );
      await chmod(cli, 0o755);
      process.env.BUGSEE_CLI_PATH = cli;

      const result = await registerJsBuild({
        outDir: join(root, 'dist'),
        appToken: 'tok',
        appVersion: '1.0.0',
        appBuild: '1',
        setting: 'always',
        bundler: {},
        env: {},
        projectRoot: join(root, 'dist'),
      });

      expect(result).toMatchObject({ registered: true });
      const seen = JSON.parse(await readFile(log, 'utf8')) as {
        argv: string[];
        payload: { uuid: string; package_id: string };
      };
      expect(seen.argv.slice(0, 3)).toEqual(['upload', 'build', '--payload-json']);
      expect(seen.payload.package_id).toBe('@acme/defaults');
      expect(seen.payload.uuid).toBe(
        deriveBuildUuid([ID_A], {
          packageId: '@acme/defaults',
          version: '1.0.0',
          build: '1',
          configuration: '',
        }),
      );
    });
  });
});
