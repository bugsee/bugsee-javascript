import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOOLEAN_OPTION,
  BOOLEAN_OR_BAG_OPTION,
  FAIL_CLOSED_BOOLEAN_OPTION,
  FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION,
  FAIL_ON_BOOLEAN_OPTION,
  type OptionDefinition,
  resolveLaunchOptions,
} from '@bugsee/core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// R3V-3. EVERY boolean-typed launch option of EVERY platform has an explicit fail direction, and that direction is
// pinned HERE. The test reads three things STATICALLY (so a future option cannot dodge it):
//   1. every boolean-typed property of every launch-options interface (the TypeScript checker, as
//      relaunch-options.test.ts does);
//   2. every option DEFINITION (`{ friendly: '...', ...NORMALISER }`) in the packages' sources, with the shared
//      normaliser it spreads;
//   3. the DIRECTIONS table below, the documented behaviour on an INVALID value.
// A boolean interface option that has neither a normalised definition nor an entry in RAW_STRICT fails the test:
// a new raw `options.x ?? true` read cannot land silently. Each direction is then also proven BEHAVIOURALLY over
// the whole value set (undefined, null, 0, '', false, 'false', 'true', 1, true, {}) through the real resolver.
//
//   off      data capture that is ON by default, or collects more: an invalid value is OFF (fail closed)
//   on       protective (hides/blocks data): an invalid value is ON
//   default  keeps the option's default (it is the safe side, or not a privacy switch); only the boolean flips it
// (WebView/Electron/performance consumers of the same rule are covered by their own package tests.)

const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Direction = 'off' | 'on' | 'default';

/** The documented invalid-value behaviour of every normalised boolean option, by friendly name. */
const DIRECTIONS: Record<string, Direction> = {
  // core (every platform)
  captureLogs: 'off',
  captureNetwork: 'off',
  captureNetworkBodies: 'off',
  captureSystemTraces: 'off',
  captureSystemEvents: 'off',
  captureBreadcrumbs: 'off',
  captureNetworkBodyWithoutType: 'default', // default OFF: only boolean true enables
  detectHttpErrors: 'default', // default OFF
  detectCrashes: 'default', // default ON, a non-privacy safety net
  captureNetworkDefaultSanitizer: 'default', // default ON: the redaction stays on
  // browser
  captureInteractions: 'off',
  captureViewHierarchy: 'off',
  startInBlackout: 'on',
  replay: 'default', // default ON; masking is fail-closed on its own
  persistUserIdentifier: 'default', // default OFF
  reportSummaryRequired: 'default',
  reportDescriptionRequired: 'default',
  reportEmailRequired: 'default',
  reportLabelsEnabled: 'default',
  reportLabelsRequired: 'default',
  reportPrioritySelectorEnabled: 'default',
  // node
  profiling: 'default', // default OFF
  detectHangs: 'default', // default ON, a diagnostic
  captureLocalVariables: 'off',
  captureSourceContext: 'off',
  instrumentIncomingRequests: 'default', // default ON: only boolean false opts out
  // webview
  captureObscuring: 'on',
  // webworker
  persist: 'off',
  // performance (umbrella)
  performanceMonitoring: 'off',
  traceNavigations: 'off',
  traceInteractions: 'off',
  propagateTrace: 'default', // default OFF (browser): only boolean true opts in
};

/**
 * Boolean-typed interface options that are NOT read through the normaliser, each with why that is safe. Keyed
 * `package:option`. Everything here is either strictly `=== true` (OFF unless boolean true), read through the
 * `resolveFailOnBoolean` helper, or not a privacy switch.
 */
const RAW_STRICT: Record<string, string> = {
  'browser:persist': 'read `=== true`: OFF unless boolean true',
  'browser:recover': 'durability behaviour of already-persisted data, not a capture switch',
  'browser:holdBlackout':
    'INTERNAL silent hold, read through resolveFailOnBoolean (invalid => dark)',
  'electron:holdBlackout':
    'INTERNAL silent hold, read through resolveFailOnBoolean (invalid => dark)',
  'electron:persist': 'browser option, read `=== true`',
  'electron:recover': 'durability behaviour, not a capture switch',
  'node:recover': 'durability behaviour of already-persisted data, not a capture switch',
  'node:exitOnUncaught': 'process policy, not a capture switch',
  'electron:exitOnUncaught': 'node option: process policy, not a capture switch',
  'node:propagateTrace':
    'default ON, allowlist-gated (nothing propagates without tracePropagationTargets)',
  'electron:propagateTrace': 'node option: default ON, allowlist-gated',
  'webworker:recover': 'durability behaviour, not a capture switch',
  'vercel-edge:partitionCaptureByTenant': 'read `=== true`: OFF unless boolean true',
  'webview:reportTrigger': 'enables native report gestures (a UI trigger, no capture)',
  'bugsee:persist': 'browser option, read `=== true`',
  'bugsee:recover': 'durability behaviour, not a capture switch',
  'bugsee:holdBlackout':
    'INTERNAL silent hold, read through resolveFailOnBoolean (invalid => dark)',
  'bugsee:exitOnUncaught': 'process policy, not a capture switch',
  'bugsee:otelConsume': 'read `=== true`: OFF unless boolean true',
};

/** Which packages' definitions a launch-options interface can see. */
const ALL = ['core', 'node', 'browser', 'webworker', 'vercel-edge', 'webview', 'performance'];
const UMBRELLA = ['core', 'node', 'browser', 'performance']; // what the umbrella entries launch
const INTERFACES: Array<[string, string, string, string[]]> = [
  ['node', 'src/launch.ts', 'BugseeLaunchOptions', ['core', 'node']],
  ['browser', 'src/launch.ts', 'BugseeLaunchOptions', ['core', 'browser']],
  ['webworker', 'src/launch.ts', 'BugseeWorkerLaunchOptions', ['core', 'webworker']],
  ['vercel-edge', 'src/launch.ts', 'BugseeEdgeLaunchOptions', ['core', 'vercel-edge']],
  ['webview', 'src/launch.ts', 'BugseeWebViewLaunchOptions', ['core', 'webview']],
  ['bugsee', 'src/launch.ts', 'BugseeLaunchOptionsWithPerformance', UMBRELLA],
  ['bugsee', 'src/server-launch.ts', 'BugseeServerLaunchOptions', UMBRELLA],
  ['electron', 'src/launch-main.ts', 'LaunchMainOptions', ['core', 'node']],
  ['electron', 'src/launch-renderer.ts', 'LaunchRendererOptions', ['core', 'browser']],
];

function booleanKeys(pkg: string, file: string, name: string): string[] {
  const root = join(packages, pkg);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (configPath === undefined) {
    throw new Error(`no tsconfig for ${pkg}`);
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const target = join(root, file);
  const program = ts.createProgram([target], { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(target);
  const declaration = source?.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (declaration === undefined) {
    throw new Error(`${name} not found in ${target}`);
  }
  return checker
    .getPropertiesOfType(checker.getTypeAtLocation(declaration))
    .filter((property) => {
      const type = checker.getTypeOfSymbolAtLocation(property, declaration);
      const parts = type.isUnion() ? type.types : [type];
      return parts.some((part) => (part.flags & ts.TypeFlags.BooleanLike) !== 0);
    })
    .map((property) => property.getName());
}

const SPREADS: Record<string, Direction | 'plain'> = {
  BOOLEAN_OPTION: 'default',
  boolean: 'default',
  BOOLEAN_OR_BAG_OPTION: 'default',
  FAIL_CLOSED_BOOLEAN_OPTION: 'off',
  failClosed: 'off',
  FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION: 'off',
  FAIL_ON_BOOLEAN_OPTION: 'on',
};

interface Definition {
  pkg: string;
  friendly: string;
  boolDefault: boolean | undefined;
  spreads: string[];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !/\.(test|test-d|d)\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Every `{ friendly: '…', default: <bool>, ...SPREAD }` object literal in a package's non-test sources. */
function definitionsOf(pkg: string): Definition[] {
  const found: Definition[] = [];
  for (const file of sourceFiles(join(packages, pkg, 'src'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.ESNext,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        let friendly: string | undefined;
        let boolDefault: boolean | undefined;
        const spreads: string[] = [];
        for (const property of node.properties) {
          if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
            spreads.push(property.expression.text);
          } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
            if (property.name.text === 'friendly' && ts.isStringLiteral(property.initializer)) {
              friendly = property.initializer.text;
            } else if (property.name.text === 'default') {
              boolDefault =
                property.initializer.kind === ts.SyntaxKind.TrueKeyword
                  ? true
                  : property.initializer.kind === ts.SyntaxKind.FalseKeyword
                    ? false
                    : undefined;
            }
          }
        }
        if (friendly !== undefined && boolDefault !== undefined) {
          found.push({ pkg, friendly, boolDefault, spreads });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const definitions = ALL.flatMap(definitionsOf);
const directionOf = (definition: Definition): Direction | undefined =>
  definition.spreads.map((name) => SPREADS[name]).find((d): d is Direction => d !== undefined);

describe('every boolean launch option has an explicit, tested fail direction (R3V-3)', () => {
  it('finds the definitions it is meant to audit (guards the scanner itself)', () => {
    const names = definitions.map((d) => d.friendly);
    for (const expected of ['captureLogs', 'startInBlackout', 'captureObscuring', 'persist']) {
      expect(names).toContain(expected);
    }
  });

  it('every boolean definition goes through a shared normaliser AND is classified in DIRECTIONS', () => {
    const problems: string[] = [];
    for (const definition of definitions) {
      const direction = directionOf(definition);
      if (direction === undefined) {
        problems.push(`${definition.pkg}:${definition.friendly} has no shared normaliser`);
      } else if (DIRECTIONS[definition.friendly] !== direction) {
        problems.push(
          `${definition.pkg}:${definition.friendly} is ${direction} but DIRECTIONS says ${DIRECTIONS[definition.friendly]}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('DIRECTIONS names no option that no longer exists', () => {
    const names = new Set(definitions.map((d) => d.friendly));
    expect(Object.keys(DIRECTIONS).filter((name) => !names.has(name))).toEqual([]);
  });

  it('every boolean-typed option of every platform interface is normalised or explicitly RAW_STRICT', () => {
    const unclassified: string[] = [];
    const usedRaw = new Set<string>();
    for (const [pkg, file, name, visible] of INTERFACES) {
      for (const key of booleanKeys(pkg, file, name)) {
        const normalised = definitions.some((d) => visible.includes(d.pkg) && d.friendly === key);
        if (normalised) {
          continue;
        }
        if (`${pkg}:${key}` in RAW_STRICT) {
          usedRaw.add(`${pkg}:${key}`);
        } else {
          unclassified.push(`${pkg}:${name}.${key}`);
        }
      }
    }
    expect(
      unclassified,
      'read these through a shared normaliser (packages/core/src/options.ts) or list them in RAW_STRICT with a reason',
    ).toEqual([]);
    expect(Object.keys(RAW_STRICT).filter((key) => !usedRaw.has(key))).toEqual([]);
  });

  describe('behaviour over the whole value set, through the real resolver', () => {
    const VALUES: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['0', 0],
      ["''", ''],
      ['false', false],
      ["'false'", 'false'],
      ["'true'", 'true'],
      ['1', 1],
      ['true', true],
      ['{}', {}],
    ];
    const NORMALISERS = {
      off: FAIL_CLOSED_BOOLEAN_OPTION,
      on: FAIL_ON_BOOLEAN_OPTION,
      default: BOOLEAN_OPTION,
    } as const;
    const BAGS = {
      off: FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION,
      default: BOOLEAN_OR_BAG_OPTION,
    } as const;
    const BAG_OPTIONS = new Set(['replay', 'captureLocalVariables', 'captureSourceContext']);

    for (const definition of definitions) {
      const direction = directionOf(definition);
      if (direction === undefined) {
        continue;
      }
      const isBag = BAG_OPTIONS.has(definition.friendly);
      const normaliser = isBag
        ? BAGS[direction as keyof typeof BAGS]
        : NORMALISERS[direction as keyof typeof NORMALISERS];
      const def: OptionDefinition = {
        friendly: definition.friendly,
        key: `k.${definition.friendly}`,
        default: definition.boolDefault,
        ...normaliser,
      };
      it(`${definition.pkg}:${definition.friendly} (${direction}, default ${definition.boolDefault})`, () => {
        for (const [label, value] of VALUES) {
          const errors: Error[] = [];
          const bag = isBag && label === '{}';
          const resolved = resolveLaunchOptions(
            { [def.friendly]: value },
            [def],
            (e) => void errors.push(e),
          );
          const effective = resolved.canonical[def.key];
          const valid = value === undefined || typeof value === 'boolean' || bag;
          if (value === undefined) {
            expect(effective, label).toBe(definition.boolDefault);
          } else if (typeof value === 'boolean') {
            expect(effective, label).toBe(value);
          } else if (bag) {
            expect(effective, label).toBe(true); // an options bag means "on, configured"
          } else {
            const expected =
              direction === 'off' ? false : direction === 'on' ? true : definition.boolDefault;
            expect(effective, `${label} => ${String(expected)}`).toBe(expected);
          }
          expect(errors.length, `${label} reported`).toBe(valid ? 0 : 1);
        }
      });
    }
  });
});
