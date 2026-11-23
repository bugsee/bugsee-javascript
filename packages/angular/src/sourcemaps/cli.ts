// The `bugsee-angular-upload` command: argument parsing and reporting around uploadAngularSourcemaps. Kept free of
// process globals (the bin passes them in) so it is unit-tested; bin.ts is the three-line shell around it.
import {
  type AngularUploadOptions,
  type AngularUploadResult,
  uploadAngularSourcemaps,
} from './upload';

export const HELP = `bugsee-angular-upload — upload the source maps of an Angular build to Bugsee.

Run it after \`ng build\` (the \`build:bugsee\` script that \`ng add @bugsee/angular\` adds does both):

  ng build && bugsee-angular-upload

It stamps debug-IDs into the bundles in dist/<project>/browser, uploads the maps, registers the build and
removes the local maps. The app token comes from BUGSEE_APP_TOKEN or .env.bugsee-build-plugin.

Options
  --project <name>            Application project (default: the only application in angular.json)
  -c, --configuration <name>  The ng build configuration the output came from (default: the target's default)
  --dist <dir>                The browser output directory, when it is not where angular.json says
  --output-path <dir>         What you gave ng build --output-path (browser/ below it is used when present)
  --app-version <version>     App version (default: BUGSEE_APP_VERSION, then package.json)
  --app-build <build>         Build number (default: BUGSEE_APP_BUILD, then the CI commit)
  --endpoint <url>            API endpoint (default: BUGSEE_ENDPOINT)
  --dry-run                   Run the whole flow without uploading or deleting anything
  --keep-maps                 Keep the local .map files after uploading
  --strip-sources-content     Upload maps without their embedded source
  --fail-on-error             Exit non-zero when the upload fails (default: warn and exit 0)
  --upload-in-development     Also upload from a development configuration
  --no-vcs                    Do not capture the commit / branch
  -h, --help                  Show this help
`;

type Options = AngularUploadOptions;

const VALUE_FLAGS: Record<string, keyof Options> = {
  '--project': 'project',
  '--configuration': 'configuration',
  '-c': 'configuration',
  '--dist': 'dist',
  '--output-path': 'outputPath',
  '--app-version': 'appVersion',
  '--app-build': 'appBuild',
  '--endpoint': 'endpoint',
};

const SWITCHES: Record<string, [keyof Options, boolean]> = {
  '--dry-run': ['dryRun', true],
  '--keep-maps': ['deleteMaps', false],
  '--strip-sources-content': ['stripSourcesContent', true],
  '--fail-on-error': ['failOnError', true],
  '--upload-in-development': ['uploadInDevelopment', true],
  '--no-vcs': ['vcs', false],
};

/** Parse argv (without the node and script entries). Throws a usage error for anything it does not know. */
export function parseArgs(argv: readonly string[]): { options: Options; help?: true } {
  const options: Record<string, unknown> = {};
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag === '-h' || flag === '--help') {
      help = true;
    } else if (flag === '--app-token') {
      throw new Error(
        'the app token is not taken on the command line (it would land in shell history): set BUGSEE_APP_TOKEN',
      );
    } else if (flag in VALUE_FLAGS) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${flag} needs a value`);
      }
      options[VALUE_FLAGS[flag] as string] = value;
    } else if (flag in SWITCHES) {
      if (eq !== -1) {
        throw new Error(`${flag} does not take a value`);
      }
      const [key, value] = SWITCHES[flag] as [string, boolean];
      options[key] = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option "${flag}"`);
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }
  return help ? { options: options as Options, help: true } : { options: options as Options };
}

export interface CliIo {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout(message: string): void;
  stderr(message: string): void;
}

/** Run the command. Resolves to the process exit code: 0 done, 1 failed, 2 misused. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  upload: (options: Options) => Promise<AngularUploadResult> = uploadAngularSourcemaps,
): Promise<number> {
  let parsed: { options: Options; help?: true };
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.stderr(`[bugsee] ${(error as Error).message}\nRun with --help for the options.\n`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(HELP);
    return 0;
  }
  try {
    const out = await upload({ ...parsed.options, cwd: io.cwd, env: io.env });
    if (out.status === 'uploaded') {
      if (parsed.options.dryRun === true) {
        io.stdout(
          `[bugsee] dry run: checked the source maps of ${out.outDir}; nothing was uploaded or removed.\n`,
        );
      } else if (out.result?.uploaded === true) {
        const removed = out.result.deletedMaps.length;
        io.stdout(
          `[bugsee] uploaded the source maps of ${out.outDir}` +
            (removed > 0 ? `; removed ${removed} local map(s).\n` : '.\n'),
        );
      } else {
        io.stderr(
          `[bugsee] the source-map upload of ${out.outDir} did not complete (see above).\n`,
        );
      }
    }
    return 0;
  } catch (error) {
    io.stderr(`[bugsee] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
