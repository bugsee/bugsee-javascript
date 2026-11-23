import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAngularOutput } from './output';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'bugsee-ng-out-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const workspace = async (
  projects: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => {
  await writeFile(join(cwd, 'angular.json'), JSON.stringify({ version: 1, projects, ...extra }));
};

const app = (build: unknown, over: Record<string, unknown> = {}) => ({
  projectType: 'application',
  root: '',
  architect: { build },
  ...over,
});

describe('resolveAngularOutput', () => {
  it('finds the browser directory of an esbuild application build under dist/<project>', async () => {
    await workspace({ demo: app({ builder: '@angular/build:application', options: {} }) });
    expect(resolveAngularOutput({ cwd })).toEqual({
      project: 'demo',
      builder: '@angular/build:application',
      layout: 'application',
      configuration: undefined,
      baseDir: join(cwd, 'dist', 'demo'),
      browserDir: join(cwd, 'dist', 'demo', 'browser'),
      serverDir: join(cwd, 'dist', 'demo', 'server'),
    });
  });

  it('treats the legacy @angular-devkit/build-angular:application builder the same way', async () => {
    await workspace({
      demo: app({
        builder: '@angular-devkit/build-angular:application',
        options: { outputPath: 'out/x' },
      }),
    });
    const out = resolveAngularOutput({ cwd });
    expect(out.layout).toBe('application');
    expect(out.browserDir).toBe(join(cwd, 'out', 'x', 'browser'));
  });

  it('honours the object form of outputPath, including an empty browser folder', async () => {
    await workspace({
      demo: app({
        builder: '@angular/build:application',
        options: { outputPath: { base: 'out', browser: '', server: 'srv' } },
      }),
    });
    const out = resolveAngularOutput({ cwd });
    expect(out.browserDir).toBe(join(cwd, 'out'));
    expect(out.serverDir).toBe(join(cwd, 'out', 'srv'));
  });

  it('defaults the browser and server folders when the object form leaves them out', async () => {
    await workspace({
      demo: app({
        builder: '@angular/build:application',
        options: { outputPath: { base: 'out' } },
      }),
    });
    const out = resolveAngularOutput({ cwd });
    expect(out.browserDir).toBe(join(cwd, 'out', 'browser'));
    expect(out.serverDir).toBe(join(cwd, 'out', 'server'));
  });

  it('uses the outputPath of the chosen configuration over the options', async () => {
    await workspace({
      demo: app({
        builder: '@angular/build:application',
        options: { outputPath: 'dist/base' },
        configurations: { production: { outputPath: 'dist/prod' } },
        defaultConfiguration: 'production',
      }),
    });
    expect(resolveAngularOutput({ cwd }).browserDir).toBe(join(cwd, 'dist', 'prod', 'browser'));
    expect(resolveAngularOutput({ cwd }).configuration).toBe('production');
  });

  it('prefers an explicit configuration to the default, and merges a comma list in order', async () => {
    await workspace({
      demo: app({
        builder: '@angular/build:application',
        options: {},
        configurations: {
          production: { outputPath: 'dist/prod' },
          staging: { outputPath: 'dist/stage' },
          other: {},
        },
        defaultConfiguration: 'production',
      }),
    });
    expect(resolveAngularOutput({ cwd, configuration: 'staging' }).baseDir).toBe(
      join(cwd, 'dist', 'stage'),
    );
    expect(resolveAngularOutput({ cwd, configuration: 'production,other' }).baseDir).toBe(
      join(cwd, 'dist', 'prod'),
    );
    expect(resolveAngularOutput({ cwd, configuration: 'production,staging' }).baseDir).toBe(
      join(cwd, 'dist', 'stage'),
    );
  });

  it('ignores a configuration name the target does not define', async () => {
    await workspace({ demo: app({ builder: '@angular/build:application', options: {} }) });
    expect(resolveAngularOutput({ cwd, configuration: 'nope' }).baseDir).toBe(
      join(cwd, 'dist', 'demo'),
    );
  });

  it('uses the flat output of a webpack browser build, which has no browser subfolder', async () => {
    await workspace({
      demo: app({
        builder: '@angular-devkit/build-angular:browser',
        options: { outputPath: 'dist/legacy' },
      }),
    });
    expect(resolveAngularOutput({ cwd })).toEqual({
      project: 'demo',
      builder: '@angular-devkit/build-angular:browser',
      layout: 'flat',
      configuration: undefined,
      baseDir: join(cwd, 'dist', 'legacy'),
      browserDir: join(cwd, 'dist', 'legacy'),
    });
  });

  it('reads the base of an object outputPath for a flat builder, and defaults to dist/<project>', async () => {
    await workspace({
      a: app({
        builder: '@angular-devkit/build-angular:browser',
        options: { outputPath: { base: 'x' } },
      }),
      b: app({ builder: '@angular-devkit/build-angular:browser', options: {} }),
    });
    expect(resolveAngularOutput({ cwd, project: 'a' }).browserDir).toBe(join(cwd, 'x'));
    expect(resolveAngularOutput({ cwd, project: 'b' }).browserDir).toBe(join(cwd, 'dist', 'b'));
  });

  it("reads the `targets` spelling of a project's targets (Angular accepts it beside `architect`)", async () => {
    await writeFile(
      join(cwd, 'angular.json'),
      JSON.stringify({
        projects: {
          demo: {
            projectType: 'application',
            root: '',
            targets: {
              build: { builder: '@angular/build:application', options: { outputPath: 'out' } },
            },
          },
        },
      }),
    );
    expect(resolveAngularOutput({ cwd }).browserDir).toBe(join(cwd, 'out', 'browser'));
  });

  it('treats a target with no builder as flat', async () => {
    await workspace({ demo: app({ options: {} }) });
    const out = resolveAngularOutput({ cwd });
    expect(out.layout).toBe('flat');
    expect(out.builder).toBeUndefined();
  });

  it('keeps an absolute outputPath as it is', async () => {
    const abs = join(cwd, 'elsewhere');
    await workspace({
      demo: app({ builder: '@angular-devkit/build-angular:browser', options: { outputPath: abs } }),
    });
    expect(resolveAngularOutput({ cwd }).browserDir).toBe(abs);
  });

  it('picks the only application project, ignoring libraries', async () => {
    await workspace({
      lib: { projectType: 'library', root: 'projects/lib', architect: { build: {} } },
      demo: app({ builder: '@angular/build:application', options: {} }),
    });
    expect(resolveAngularOutput({ cwd }).project).toBe('demo');
  });

  it('asks for --project when several applications exist, naming them', async () => {
    await workspace({
      one: app({ builder: '@angular/build:application', options: {} }),
      two: app({ builder: '@angular/build:application', options: {} }),
    });
    expect(() => resolveAngularOutput({ cwd })).toThrow(/--project.*one, two/);
  });

  it('uses the legacy defaultProject when several applications exist', async () => {
    await workspace(
      {
        one: app({ builder: '@angular/build:application', options: {} }),
        two: app({ builder: '@angular/build:application', options: {} }),
      },
      { defaultProject: 'two' },
    );
    expect(resolveAngularOutput({ cwd }).project).toBe('two');
  });

  it('rejects a project that is not in the workspace, listing what is', async () => {
    await workspace({ demo: app({ builder: '@angular/build:application', options: {} }) });
    expect(() => resolveAngularOutput({ cwd, project: 'nope' })).toThrow(/"nope".*demo/);
  });

  it('rejects a workspace with no application and a project with no build target', async () => {
    await workspace({ lib: { projectType: 'library', root: 'x', architect: {} } });
    expect(() => resolveAngularOutput({ cwd })).toThrow(/no application project/);
    await workspace({ demo: { projectType: 'application', root: '', architect: {} } });
    expect(() => resolveAngularOutput({ cwd })).toThrow(/no "build" target/);
    await workspace({ demo: { projectType: 'application', root: '' } });
    expect(() => resolveAngularOutput({ cwd })).toThrow(/no "build" target/);
  });

  it('says how to proceed when there is no angular.json, and when it is not parseable', async () => {
    expect(() => resolveAngularOutput({ cwd })).toThrow(/angular\.json.*--dist/);
    await writeFile(join(cwd, 'angular.json'), '{ nope');
    expect(() => resolveAngularOutput({ cwd })).toThrow(/could not read.*angular\.json/);
  });

  it('finds angular.json in a parent directory of the working directory', async () => {
    await workspace({ demo: app({ builder: '@angular/build:application', options: {} }) });
    const nested = join(cwd, 'projects', 'demo');
    await mkdir(nested, { recursive: true });
    expect(resolveAngularOutput({ cwd: nested }).browserDir).toBe(
      join(cwd, 'dist', 'demo', 'browser'),
    );
  });

  it('reads an angular.json with comments', async () => {
    await writeFile(
      join(cwd, 'angular.json'),
      `{ // c
        "projects": { "demo": { "projectType": "application", "root": "",
          "architect": { "build": { "builder": "@angular/build:application", "options": {}, }, }, }, },
      }`,
    );
    expect(resolveAngularOutput({ cwd }).project).toBe('demo');
  });
});
