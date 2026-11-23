// `ng add @bugsee/angular` — set an Angular application up for Bugsee. Build-time only: this entry is built
// separately (CommonJS, loaded by the Angular CLI) and nothing in the runtime entry imports it, so it cannot
// reach a browser bundle.
//
// What it does, and what it deliberately does not guess:
//   - angular.json: hidden script source maps in the production configuration (never overriding a setting that
//     already produces maps).
//   - main.ts: `launch(token)` before the bootstrap; the app config / AppModule: `BugseeErrorHandler` as the
//     ErrorHandler (through Angular's own `addRootProvider`, which understands standalone and NgModule apps).
//     If the bootstrap cannot be found, nothing in the source is changed and the exact lines to add are printed.
//   - package.json: a `build:bugsee` script — `ng build`, then `bugsee-angular-upload` (see ../../sourcemaps).
//     Angular's esbuild builder has no plugin hook, so the upload is a step after the build.
//   - `.env.bugsee-build-plugin` (git-ignored) with the token for that step, when one was given.
// Every step is idempotent: running it again changes nothing.
import {
  callRule,
  chain,
  type Rule,
  type SchematicContext,
  SchematicsException,
  type Tree,
} from '@angular-devkit/schematics';
import {
  addRootProvider,
  readWorkspace,
  type TargetDefinition,
  updateWorkspace,
} from '@schematics/angular/utility';
import type { Schema } from './schema';

const PLACEHOLDER = 'YOUR_APP_TOKEN';
const ENV_FILE = '.env.bugsee-build-plugin';
const SCRIPT = 'build:bugsee';
const SOURCE_MAP = { scripts: true, styles: false, hidden: true };

type Obj = Record<string, unknown>;

/** Whether a `sourceMap` value turns script maps on: `true`, or an object that does not turn scripts off. */
const mapsScripts = (value: unknown): boolean =>
  value === true ||
  (typeof value === 'object' && value !== null && (value as Obj).scripts !== false);

const quote = (text: string): string => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Run a rule now and wait for it, so its failure can be handled here. */
function apply(rule: Rule, tree: Tree, context: SchematicContext): Promise<void> {
  return new Promise((resolve, reject) => {
    callRule(rule, tree, context).subscribe({ error: reject, complete: () => resolve() });
  });
}

interface Located {
  name: string;
  /** Application projects in the workspace — more than one means the script must name this one. */
  applications: number;
  builder: string | undefined;
  options: Obj;
  production: Obj;
  mainPath: string | undefined;
  sourceRoot: string;
}

async function locate(tree: Tree, requested: string | undefined): Promise<Located> {
  const workspace = await readWorkspace(tree);
  const apps = [...workspace.projects.entries()]
    .filter(([, project]) => project.extensions.projectType === 'application')
    .map(([name]) => name);
  let name = requested;
  if (name === undefined) {
    if (apps.length === 0) {
      throw new SchematicsException('The workspace has no application project to set up.');
    }
    if (apps.length > 1) {
      throw new SchematicsException(
        `The workspace has several applications; choose one with --project (${apps.join(', ')}).`,
      );
    }
    name = apps[0] as string;
  }
  const project = workspace.projects.get(name);
  if (project === undefined) {
    throw new SchematicsException(
      `The workspace has no project "${name}" (it has: ${[...workspace.projects.keys()].join(', ')}).`,
    );
  }
  const build = project.targets.get('build');
  if (build === undefined) {
    throw new SchematicsException(`Project "${name}" has no "build" target.`);
  }
  const options = (build.options ?? {}) as Obj;
  const entry = (options.browser ?? options.main) as string | undefined;
  return {
    name,
    applications: apps.length,
    builder: build.builder,
    options,
    production: (build.configurations?.production ?? {}) as Obj,
    mainPath: entry === undefined ? undefined : `/${entry}`,
    sourceRoot: `/${(project.sourceRoot ?? `${project.root}/src`).replace(/^\/+/, '')}`,
  };
}

/** angular.json: hidden script maps in the production configuration, unless it already produces them. */
function enableSourceMaps(project: string): Rule {
  return updateWorkspace((workspace) => {
    // `locate` already proved the project and its build target exist.
    const build = workspace.projects.get(project)?.targets.get('build') as TargetDefinition;
    const production = (build.configurations?.production ?? {}) as Obj;
    const effective = 'sourceMap' in production ? production.sourceMap : build.options?.sourceMap;
    if (mapsScripts(effective)) {
      return;
    }
    const current = production.sourceMap;
    const sourceMap =
      typeof current === 'object' && current !== null
        ? { ...(current as Obj), scripts: true, hidden: true }
        : SOURCE_MAP;
    build.configurations = {
      ...build.configurations,
      production: { ...production, sourceMap },
    } as typeof build.configurations;
  });
}

/** The end of the last top-level import in `source`, or -1. */
function endOfImports(source: string): number {
  let end = -1;
  for (const match of source.matchAll(/^import\s[^;]*?['"][^'"]+['"]\s*;?/gm)) {
    end = (match.index as number) + match[0].length;
  }
  return end;
}

/** Source without comments, so a mention in one is not read as code. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/.*$/gm, '$1');

/** The names ErrorHandler is imported under from @angular/core in `text`: `ErrorHandler` and any `as` alias. */
function errorHandlerNames(text: string): string[] {
  const names = ['ErrorHandler'];
  for (const [, list] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]@angular\/core['"]/g)) {
    for (const [, alias] of (list ?? '').matchAll(/\bErrorHandler\s+as\s+(\w+)/g)) {
      names.push(alias as string);
    }
  }
  return names;
}

const BOOTSTRAP = /\bbootstrap(Application|Module|ModuleFactory)\s*\(/;

function manualSteps(token: string): string {
  return (
    `  // main.ts, before the app starts\n  import { launch } from '@bugsee/angular';\n  launch(${quote(token)});\n\n` +
    `  // your providers (app.config.ts or AppModule)\n  import { ErrorHandler } from '@angular/core';\n` +
    `  import { BugseeErrorHandler } from '@bugsee/angular';\n  { provide: ErrorHandler, useClass: BugseeErrorHandler }`
  );
}

/** main.ts: launch before the bootstrap; the providers: BugseeErrorHandler. Explains instead of guessing. */
function instrument(located: Located, token: string): Rule {
  return async (tree, context) => {
    const main =
      located.mainPath !== undefined && tree.exists(located.mainPath)
        ? located.mainPath
        : undefined;
    const source = main === undefined ? undefined : tree.readText(main);
    if (main === undefined || source === undefined || !BOOTSTRAP.test(source)) {
      context.logger.warn(
        `Bugsee: could not find where the app bootstraps (looked for bootstrapApplication / bootstrapModule in ` +
          `${located.mainPath ?? "the build target's entry"}), so no source was changed. Add this yourself:\n\n${manualSteps(token)}\n`,
      );
      return;
    }
    const code = withoutComments(source);
    // An existing launch CALL (not a mention of the package, not an imported helper) is left exactly as it is.
    if (!(/@bugsee\//.test(code) && /\blaunch\s*\(/.test(code))) {
      const call = `// Launch Bugsee before the app starts, so startup errors are captured.\nlaunch(${quote(token)});`;
      const importsLaunch = /import\s*\{[^}]*\blaunch\b[^}]*\}\s*from\s*['"]@bugsee\//.test(code);
      const statement = importsLaunch ? '' : `import { launch } from '@bugsee/angular';\n\n`;
      const end = endOfImports(source);
      tree.overwrite(
        main,
        end === -1
          ? `${statement}${call}\n\n${source}`
          : `${source.slice(0, end)}\n${statement === '' ? '\n' : statement}${call}${source.slice(end)}`,
      );
    }
    let provided = false;
    let foreign = false;
    tree.getDir(located.sourceRoot).visit((path) => {
      if (!path.endsWith('.ts')) {
        return;
      }
      if (path.endsWith('.spec.ts')) {
        return;
      }
      const text = withoutComments(tree.readText(path));
      const tokens = errorHandlerNames(text).join('|');
      if (new RegExp(`provide\\s*:\\s*(?:${tokens})\\b[^}]*\\bBugseeErrorHandler\\b`).test(text)) {
        provided = true;
      } else if (new RegExp(`provide\\s*:\\s*(?:${tokens})\\b`).test(text)) {
        foreign = true;
      }
    });
    if (provided) {
      return;
    }
    if (foreign) {
      // Providers are last-wins: adding ours would silently replace theirs. They choose how to combine them.
      context.logger.warn(
        `Bugsee: your app already provides its own ErrorHandler, so BugseeErrorHandler was not added (it would replace ` +
          `yours). Report from inside it instead:\n\n  import { reportAngularError } from '@bugsee/angular';\n` +
          `  handleError(error: unknown) { reportAngularError(error); /* then your handling */ }\n\n` +
          `or wrap yours:\n\n  { provide: ErrorHandler, useFactory: () => createAngularErrorHandler({ delegate: new MyHandler() }) }\n`,
      );
      return;
    }
    try {
      await apply(
        addRootProvider(
          located.name,
          ({ code, external }) =>
            code`{ provide: ${external('ErrorHandler', '@angular/core')}, useClass: ${external('BugseeErrorHandler', '@bugsee/angular')} }`,
        ),
        tree,
        context,
      );
    } catch (error) {
      context.logger.warn(
        `Bugsee: could not register BugseeErrorHandler (${(error as Error).message}). Add it to your providers ` +
          `yourself:\n\n  { provide: ErrorHandler, useClass: BugseeErrorHandler }  // both from '@angular/core' / '@bugsee/angular'\n`,
      );
    }
  };
}

/** package.json: the `build:bugsee` script. */
function addBuildScript(located: Located): Rule {
  return (tree, context) => {
    if (!tree.exists('/package.json')) {
      context.logger.warn(
        `Bugsee: no package.json found, so the ${SCRIPT} script was not added. Run:\n  ng build --configuration production && bugsee-angular-upload --configuration production`,
      );
      return;
    }
    const text = tree.readText('/package.json');
    const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
    if (pkg.scripts?.[SCRIPT] !== undefined) {
      context.logger.info(`Bugsee: the ${SCRIPT} script is already there; left as it is.`);
      return;
    }
    const several = located.applications > 1;
    pkg.scripts = {
      ...pkg.scripts,
      [SCRIPT]:
        `ng build${several ? ` ${located.name}` : ''} --configuration production && ` +
        `bugsee-angular-upload${several ? ` --project ${located.name}` : ''} --configuration production`,
    };
    const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  ';
    tree.overwrite(
      '/package.json',
      `${JSON.stringify(pkg, null, indent)}${text.endsWith('\n') ? '\n' : ''}`,
    );
  };
}

/** `.env.bugsee-build-plugin` with the token for the build step, git-ignored. */
function keepToken(token: string | undefined): Rule {
  return (tree, context) => {
    if (token === undefined) {
      return;
    }
    if (!tree.exists(`/${ENV_FILE}`)) {
      tree.create(`/${ENV_FILE}`, `BUGSEE_APP_TOKEN=${token}\n`);
    } else {
      const text = tree.readText(`/${ENV_FILE}`);
      const existing = /^\s*BUGSEE_APP_TOKEN\s*=\s*(.*?)\s*$/m.exec(text)?.[1];
      if (existing !== undefined && existing !== token) {
        context.logger.warn(
          `Bugsee: ${ENV_FILE} already has a different BUGSEE_APP_TOKEN than the one you gave, and it was left as it is. ` +
            `launch() uses the token you gave, the source-map upload uses the file's: if they are not the same app, ` +
            `crash reports cannot be symbolicated. Make them match.`,
        );
      }
      if (!/^\s*BUGSEE_APP_TOKEN\s*=/m.test(text)) {
        tree.overwrite(
          `/${ENV_FILE}`,
          `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}BUGSEE_APP_TOKEN=${token}\n`,
        );
      }
    }
    if (!tree.exists('/.gitignore')) {
      tree.create('/.gitignore', `${ENV_FILE}\n`);
    } else {
      const ignored = tree.readText('/.gitignore');
      if (!ignored.split(/\r?\n/).some((line) => line.trim() === ENV_FILE)) {
        tree.overwrite(
          '/.gitignore',
          `${ignored}${ignored.endsWith('\n') ? '' : '\n'}${ENV_FILE}\n`,
        );
      }
    }
  };
}

/** Say what the build step does for this project's configuration. */
function explain(located: Located, token: string | undefined): Rule {
  return (_tree, context) => {
    const effective = { ...located.options, ...located.production } as Obj;
    context.logger.info(
      `Bugsee: source maps are uploaded by \`npm run ${SCRIPT}\` (builder: ${located.builder ?? 'unknown'}); ` +
        `plain \`ng build\` does not upload.`,
    );
    if (effective.subresourceIntegrity === true) {
      context.logger.info(
        `Bugsee: subresourceIntegrity is on. The upload step stamps the bundles, then the integrity hashes in ` +
          `index.html are re-written to match, so the page keeps loading.`,
      );
    }
    if (effective.serviceWorker) {
      context.logger.info(
        `Bugsee: serviceWorker is on. ngsw.json (one per locale) pins a SHA-1 of every file, so the upload step ` +
          `re-computes those hashes after stamping and checks them; if one cannot be reconciled it restores the build and uploads nothing.`,
      );
    }
    if (token === undefined) {
      context.logger.warn(
        `Bugsee: no app token was given, so launch() has the placeholder ${PLACEHOLDER}. Put your token there, and set ` +
          `BUGSEE_APP_TOKEN (or ${ENV_FILE}) wherever you run \`npm run ${SCRIPT}\`.`,
      );
    }
  };
}

export function ngAdd(options: Schema = {}): Rule {
  return async (tree) => {
    const located = await locate(tree, options.project);
    const trimmed = options.appToken?.trim();
    const token = trimmed === undefined || trimmed === '' ? undefined : trimmed;
    if (token !== undefined && /[\s"'`#\\]/.test(token)) {
      throw new SchematicsException(
        'The app token must not contain whitespace, a line break, quotes, backticks, backslashes or #.',
      );
    }
    return chain([
      enableSourceMaps(located.name),
      instrument(located, token ?? PLACEHOLDER),
      addBuildScript(located),
      keepToken(token),
      explain(located, token),
    ]);
  };
}
