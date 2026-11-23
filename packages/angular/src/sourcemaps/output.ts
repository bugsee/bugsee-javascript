// Where `ng build` writes its browser bundles, read from angular.json — so the upload step needs no path
// from the user. The layouts are Angular's own (checked against @angular/build 22's `application` schema):
//   - `application` builders (esbuild; `@angular/build:application`, `@angular-devkit/build-angular:application`):
//     `outputPath` is a string (the base) or `{ base, browser, server, media }`; the browser bundles are in
//     `<base>/<browser ?? 'browser'>` and an SSR server in `<base>/<server ?? 'server'>`.
//   - everything else (the webpack `browser` builder, `browser-esbuild`): `outputPath` IS the browser directory.
// The default base is `dist/<project>`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseJsonc } from './jsonc';

export interface AngularOutput {
  project: string;
  builder: string | undefined;
  layout: 'application' | 'flat';
  /** The configuration(s) the output was resolved under (`undefined`: none). */
  configuration: string | undefined;
  /** The build's output root: the browser directory, plus the server directory of an SSR build. */
  baseDir: string;
  /** Where the browser bundles (and `index.html`) are. */
  browserDir: string;
  /** Where an SSR build's server bundles would be. Application builders only; it may not exist. */
  serverDir?: string;
}

export interface ResolveAngularOutputOptions {
  /** The directory the command runs in; angular.json is looked for here and in its parents. */
  cwd: string;
  /** Application project name. Default: the only application, or the legacy `defaultProject`. */
  project?: string;
  /** `ng build --configuration`: one name or a comma list. Default: the target's `defaultConfiguration`. */
  configuration?: string;
}

type Json = Record<string, unknown>;

const APPLICATION_BUILDERS = new Set([
  '@angular/build:application',
  '@angular-devkit/build-angular:application',
]);

function findWorkspaceFile(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const candidate = join(dir, 'angular.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

function readWorkspace(cwd: string): { file: string; json: Json } {
  const file = findWorkspaceFile(cwd);
  if (file === undefined) {
    throw new Error(
      `no angular.json found in ${cwd} or above. Run this from your Angular workspace, or give the build output ` +
        `directory yourself with --dist.`,
    );
  }
  try {
    return { file, json: parseJsonc(readFileSync(file, 'utf8')) as Json };
  } catch (error) {
    throw new Error(`could not read ${file}: ${String(error)}`);
  }
}

function pickProject(json: Json, requested: string | undefined): string {
  const projects = (json.projects ?? {}) as Record<string, Json>;
  const names = Object.keys(projects);
  if (requested !== undefined) {
    if (!(requested in projects)) {
      throw new Error(`the workspace has no project "${requested}" (it has: ${names.join(', ')})`);
    }
    return requested;
  }
  const apps = names.filter((name) => projects[name]?.projectType === 'application');
  if (apps.length === 0) {
    throw new Error('the workspace has no application project to upload source maps for');
  }
  const legacyDefault = json.defaultProject;
  if (typeof legacyDefault === 'string' && apps.includes(legacyDefault)) {
    return legacyDefault;
  }
  if (apps.length > 1) {
    throw new Error(
      `the workspace has several applications; pick one with --project (${apps.join(', ')})`,
    );
  }
  return apps[0] as string;
}

/** Work out where `ng build` writes the browser bundles of a project, from angular.json. */
export function resolveAngularOutput(options: ResolveAngularOutputOptions): AngularOutput {
  const { file, json } = readWorkspace(options.cwd);
  const root = dirname(file);
  const project = pickProject(json, options.project);
  const entry = (json.projects as Record<string, Json>)[project] as Json;
  // Angular accepts `targets` as a spelling of `architect`.
  const target = ((entry.architect ?? entry.targets) as Json | undefined)?.build as
    | Json
    | undefined;
  if (target === undefined) {
    throw new Error(`project "${project}" has no "build" target`);
  }
  const builder = target.builder as string | undefined;
  const configurations = (target.configurations ?? {}) as Record<string, Json>;
  const chosen =
    options.configuration ??
    (typeof target.defaultConfiguration === 'string' ? target.defaultConfiguration : undefined);
  let merged: Json = { ...(target.options as Json | undefined) };
  for (const name of chosen?.split(',') ?? []) {
    merged = { ...merged, ...configurations[name.trim()] };
  }

  const layout =
    builder !== undefined && APPLICATION_BUILDERS.has(builder) ? 'application' : 'flat';
  const outputPath = merged.outputPath as
    | string
    | { base: string; browser?: string; server?: string }
    | undefined;
  const base =
    typeof outputPath === 'string' ? outputPath : (outputPath?.base ?? join('dist', project));
  const baseDir = isAbsolute(base) ? base : join(root, base);
  if (layout === 'flat') {
    return { project, builder, layout, configuration: chosen, baseDir, browserDir: baseDir };
  }
  const parts: { browser?: string; server?: string } =
    typeof outputPath === 'object' ? outputPath : {};
  return {
    project,
    builder,
    layout,
    configuration: chosen,
    baseDir,
    browserDir: join(baseDir, parts.browser ?? 'browser'),
    serverDir: join(baseDir, parts.server ?? 'server'),
  };
}
