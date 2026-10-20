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
import { createSharedProgram, TS_PROGRAM_TEST_TIMEOUT_MS } from './ts-program-cache.test-helper';

// EVERY boolean-typed launch option of EVERY platform has an explicit fail direction, and that direction is
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
// The SAFE side is classified explicitly per option: "OFF unless true" is right for capture, WRONG for an
// option that PROTECTS (tenant partitioning, canvas blocking, blackout, obscuring), whose invalid value must be ON.
// Nested option bags (`replay.*`, `captureLocalVariables.*`, `traceResponse.*`) are audited by NESTED below.
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
  replay: 'off', // default ON, collects the DOM: an invalid scalar is OFF; masking is fail-closed on its own
  persistUserIdentifier: 'default', // default OFF
  captureUserIdle: 'default', // default OFF (opt-in behavioural trace): only boolean true enables
  reportSummaryRequired: 'default',
  reportDescriptionRequired: 'default',
  reportEmailRequired: 'default',
  reportLabelsEnabled: 'default',
  reportLabelsRequired: 'default',
  reportPrioritySelectorEnabled: 'default',
  // node
  profiling: 'default', // default OFF
  captureDiskSpace: 'default', // default OFF: only boolean true enables
  detectHangs: 'default', // default ON, a diagnostic
  captureLocalVariables: 'off',
  captureSourceContext: 'off',
  instrumentIncomingRequests: 'off', // default ON, collects request data: an invalid value is OFF
  // webview
  captureObscuring: 'on',
  // webworker
  persist: 'off',
  // performance (umbrella)
  performanceMonitoring: 'off',
  traceNavigations: 'off',
  traceInteractions: 'off',
  // `propagateTrace` exists TWICE with different defaults, so it is keyed by package:
  'node:propagateTrace': 'off', // node's own definition: default ON, invalid => OFF
  'performance:propagateTrace': 'default', // browser perf-sourced: default OFF, only boolean true opts in
};

/**
 * Boolean-typed interface options that are NOT read through the normaliser, each with its SAFE side and why the
 * raw read is safe. Keyed `package:option`.
 *   off  capture/collection: invalid is OFF; the read is strictly `=== true` (OFF unless boolean true)
 *   on   PROTECTS: invalid must be ON; the read is `resolveFailOnBoolean` (or a pass-through of it)
 *   n/a  not a capture/privacy switch (durability / process policy / UI trigger)
 * `check` (when present) is a source pattern that MUST appear in the package's non-test sources: it pins the read
 * that makes the classification true, so changing the read back to `=== true` fails here.
 */
interface RawEntry {
  safe: 'off' | 'on' | 'n/a';
  why: string;
  check?: [pkg: string, pattern: RegExp];
}
const RAW_STRICT: Record<string, RawEntry> = {
  'browser:recover': { safe: 'n/a', why: 'durability of already-persisted data' },
  'browser:holdBlackout': {
    safe: 'on',
    why: 'INTERNAL silent hold (invalid => dark)',
    check: ['browser', /resolveFailOnBoolean\(\s*options\.holdBlackout/],
  },
  'electron:holdBlackout': {
    safe: 'on',
    why: 'INTERNAL hold, forwarded to the browser read above',
  },
  'electron:recover': { safe: 'n/a', why: 'durability behaviour' },
  'node:recover': { safe: 'n/a', why: 'durability of already-persisted data' },
  'node:exitOnUncaught': { safe: 'n/a', why: 'process policy' },
  'electron:exitOnUncaught': { safe: 'n/a', why: 'node option: process policy' },
  'webworker:recover': { safe: 'n/a', why: 'durability behaviour' },
  'vercel-edge:partitionCaptureByTenant': {
    safe: 'on',
    why: 'PROTECTS (cross-tenant isolation): resolveFailOnBoolean + onError',
    check: ['vercel-edge', /resolveFailOnBoolean\(\s*options\.partitionCaptureByTenant/],
  },
  'cloudflare:partitionCaptureByTenant': {
    safe: 'on',
    why: 'default ON applied only for `undefined`, AFTER the spread; invalid values reach the edge read',
    check: ['cloudflare', /options\.partitionCaptureByTenant === undefined\s*\?\s*true/],
  },
  'webview:reportTrigger': { safe: 'n/a', why: 'enables native report gestures (a UI trigger)' },
  'bugsee:recover': { safe: 'n/a', why: 'durability behaviour' },
  'bugsee:holdBlackout': { safe: 'on', why: 'INTERNAL hold, forwarded to the browser read' },
  'bugsee:exitOnUncaught': { safe: 'n/a', why: 'process policy' },
  'bugsee:otelConsume': { safe: 'off', why: 'read `=== true`: OFF unless boolean true' },
  'nextjs:exitOnUncaught': { safe: 'n/a', why: 'process policy' },
  'nextjs:recover': { safe: 'n/a', why: 'durability behaviour' },
  'nextjs:otelConsume': { safe: 'off', why: 'read `=== true`: OFF unless boolean true' },
  'nuxt:exitOnUncaught': { safe: 'n/a', why: 'process policy' },
  'nuxt:recover': { safe: 'n/a', why: 'durability behaviour' },
  'nuxt:otelConsume': { safe: 'off', why: 'read `=== true`: OFF unless boolean true' },
  'nuxt:holdBlackout': { safe: 'on', why: 'INTERNAL hold, forwarded to the browser read' },
  'nuxt:partitionCaptureByTenant': {
    safe: 'on',
    why: 'edge option forwarded to launchEdge, which reads it with resolveFailOnBoolean',
    check: ['vercel-edge', /resolveFailOnBoolean\(\s*options\.partitionCaptureByTenant/],
  },
  'nextjs:setupOtelProvider': {
    safe: 'off',
    why: 'default ON, installs a process-wide provider that consumes every span: invalid is OFF + onError',
    check: ['nextjs', /resolveFailClosedBoolean\(\s*options\.setupOtelProvider/],
  },
  'nuxt:injectTraceMeta': {
    safe: 'off',
    why: 'default ON, emits trace ids into every rendered page: invalid is OFF + onError',
    check: ['nuxt', /resolveFailClosedBoolean\(\s*injectTraceMeta/],
  },
};

/** Which packages' definitions a launch-options interface can see. */
const ALL = ['core', 'node', 'browser', 'webworker', 'vercel-edge', 'webview', 'performance'];
const UMBRELLA = ['core', 'node', 'browser', 'performance']; // what the umbrella entries launch
const INTERFACES: Array<[string, string, string, string[]]> = [
  ['node', 'src/launch.ts', 'BugseeLaunchOptions', ['core', 'node']],
  ['browser', 'src/launch.ts', 'BugseeLaunchOptions', ['core', 'browser']],
  ['webworker', 'src/launch.ts', 'BugseeWorkerLaunchOptions', ['core', 'webworker']],
  ['vercel-edge', 'src/launch.ts', 'BugseeEdgeLaunchOptions', ['core', 'vercel-edge']],
  // Cloudflare re-uses the edge interface (imported), so the checker resolves it through the import alias.
  ['cloudflare', 'src/launch.ts', 'BugseeEdgeLaunchOptions', ['core', 'vercel-edge']],
  ['webview', 'src/launch.ts', 'BugseeWebViewLaunchOptions', ['core', 'webview']],
  ['bugsee', 'src/launch.ts', 'BugseeLaunchOptionsWithPerformance', UMBRELLA],
  ['bugsee', 'src/server-launch.ts', 'BugseeServerLaunchOptions', UMBRELLA],
  ['electron', 'src/launch-main.ts', 'LaunchMainOptions', ['core', 'node']],
  ['electron', 'src/launch-renderer.ts', 'LaunchRendererOptions', ['core', 'browser']],
  // Framework adapters that read an option of their OWN: `setupOtelProvider` was `=== false` and
  // `injectTraceMeta` was truthy, so `'false'` / `0` / `null` kept them ON or flipped them the wrong way.
  ['nextjs', 'src/server.ts', 'NextjsServerOptions', UMBRELLA],
  ['nuxt', 'src/nitro.ts', 'InstallBugseeNitroOptions', UMBRELLA],
  ['nuxt', 'src/nitro-edge.ts', 'InstallBugseeNitroEdgeOptions', ['core', 'vercel-edge']],
  ['nuxt', 'src/client.ts', 'InstallBugseeClientOptions', ['core', 'browser', 'performance']],
];

function interfaceOf(
  pkg: string,
  file: string,
  name: string,
): { checker: ts.TypeChecker; declaration: ts.InterfaceDeclaration } {
  const root = join(packages, pkg);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (configPath === undefined) {
    throw new Error(`no tsconfig for ${pkg}`);
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const target = join(root, file);
  // One program per target file for the whole file: building a TypeScript program is the expensive step (seconds
  // on a shared CI runner), and several tests read the same interfaces.
  const program = createSharedProgram(target, parsed.options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(target);
  let declaration = source?.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (declaration === undefined) {
    // Not declared here: follow an import of that name to its declaration (the Cloudflare entry).
    const aliased = source?.statements
      .filter(ts.isImportDeclaration)
      .flatMap((statement) => {
        const bindings = statement.importClause?.namedBindings;
        return bindings !== undefined && ts.isNamedImports(bindings) ? [...bindings.elements] : [];
      })
      .find((element) => element.name.text === name);
    const symbol =
      aliased === undefined
        ? undefined
        : checker.getAliasedSymbol(checker.getSymbolAtLocation(aliased.name) as ts.Symbol);
    declaration = symbol?.declarations?.find(ts.isInterfaceDeclaration);
  }
  if (declaration === undefined) {
    throw new Error(`${name} not found in ${target}`);
  }
  return { checker, declaration };
}

const isBooleanLike = (checker: ts.TypeChecker, symbol: ts.Symbol, at: ts.Node): boolean => {
  const type = checker.getTypeOfSymbolAtLocation(symbol, at);
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((part) => (part.flags & ts.TypeFlags.BooleanLike) !== 0);
};

function booleanKeys(pkg: string, file: string, name: string): string[] {
  const { checker, declaration } = interfaceOf(pkg, file, name);
  return checker
    .getPropertiesOfType(checker.getTypeAtLocation(declaration))
    .filter((property) => isBooleanLike(checker, property, declaration))
    .map((property) => property.getName());
}

/** `parent.child` for every boolean-typed property of an OBJECT-typed option (an options bag), one level deep. */
function nestedBooleanKeys(pkg: string, file: string, name: string): string[] {
  const { checker, declaration } = interfaceOf(pkg, file, name);
  const found: string[] = [];
  for (const property of checker.getPropertiesOfType(checker.getTypeAtLocation(declaration))) {
    const type = checker.getTypeOfSymbolAtLocation(property, declaration);
    for (const part of type.isUnion() ? type.types : [type]) {
      const isBag =
        (part.flags & ts.TypeFlags.Object) !== 0 &&
        checker.getSignaturesOfType(part, ts.SignatureKind.Call).length === 0 &&
        !checker.isArrayType(part);
      if (isBag) {
        for (const child of checker.getPropertiesOfType(part)) {
          if (isBooleanLike(checker, child, declaration)) {
            found.push(`${property.getName()}.${child.getName()}`);
          }
        }
      }
    }
  }
  return found;
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
/** The documented direction: a `package:option` entry wins over the plain `option` one. */
const declared = (definition: Definition): Direction | undefined =>
  DIRECTIONS[`${definition.pkg}:${definition.friendly}`] ?? DIRECTIONS[definition.friendly];
const directionOf = (definition: Definition): Direction | undefined =>
  definition.spreads.map((name) => SPREADS[name]).find((d): d is Direction => d !== undefined);

// Reads many TypeScript programs from source: seconds locally, a minute on a shared CI runner. A timeout is a slow
// machine, never a verdict.
describe('every boolean launch option has an explicit, tested fail direction', {
  timeout: TS_PROGRAM_TEST_TIMEOUT_MS,
}, () => {
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
      } else if (declared(definition) !== direction) {
        problems.push(
          `${definition.pkg}:${definition.friendly} is ${direction} but DIRECTIONS says ${declared(definition)}`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('DIRECTIONS names no option that no longer exists', () => {
    const names = new Set(definitions.flatMap((d) => [d.friendly, `${d.pkg}:${d.friendly}`]));
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

  it('every RAW_STRICT classification that names a read is still true in the source', () => {
    const missing: string[] = [];
    for (const [key, entry] of Object.entries(RAW_STRICT)) {
      if (entry.check === undefined) {
        continue;
      }
      const [pkg, pattern] = entry.check;
      const found = sourceFiles(join(packages, pkg, 'src')).some((file) =>
        pattern.test(readFileSync(file, 'utf8')),
      );
      if (!found) {
        missing.push(`${key}: ${String(pattern)} not found in packages/${pkg}/src`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('a protecting (safe: on) option is never classified as a capture (safe: off) one', () => {
    // The error was exactly this: a protecting option filed under "OFF unless true".
    const protecting = Object.entries(RAW_STRICT)
      .filter(([, e]) => e.safe === 'on')
      .map(([k]) => k);
    expect(protecting.sort()).toEqual(
      [
        'browser:holdBlackout',
        'bugsee:holdBlackout',
        'cloudflare:partitionCaptureByTenant',
        'electron:holdBlackout',
        'nuxt:holdBlackout',
        'nuxt:partitionCaptureByTenant',
        'vercel-edge:partitionCaptureByTenant',
      ].sort(),
    );
  });

  // The flat table above cannot see an option READ INSIDE a bag (`replay.canvas`, `blockAllCanvas`,
  // `captureLocalVariables.includeCaught`): a raw `options.replay.canvas` read dodged it, and `'false'` / `0`
  // enabled canvas pixel recording. Every boolean-typed property of every option BAG is therefore classified
  // here with its safe side AND pinned to the source read that makes the classification true.
  const NESTED: Record<
    string,
    { safe: 'off' | 'on'; why: string; check: [pkg: string, pattern: RegExp] }
  > = {
    'replay.maskAllText': {
      safe: 'on',
      why: 'masking: invalid keeps the (ON) default',
      check: ['replay', /readBoolean\(source, 'maskAllText', true\)/],
    },
    'replay.maskAllInputs': {
      safe: 'on',
      why: 'masking: invalid keeps the (ON) default',
      check: ['replay', /readBoolean\(source, 'maskAllInputs', true\)/],
    },
    'replay.blockAllMedia': {
      safe: 'on',
      why: 'blocking: invalid keeps the (ON) default',
      check: ['replay', /readBoolean\(source, 'blockAllMedia', true\)/],
    },
    'replay.blockAllCanvas': {
      safe: 'on',
      why: 'blocking PROTECTS: invalid is ON + onError',
      check: ['replay', /blockAllCanvasRaw !== false/],
    },
    'replay.canvas': {
      safe: 'off',
      why: 'records unmasked pixels: only boolean true or a plain object enables it',
      check: ['browser', /canvasOption === true \|\| canvasIsBag/],
    },
    'captureLocalVariables.includeCaught': {
      safe: 'off',
      why: 'pauses on every caught throw: only boolean true enables it',
      check: ['node', /readSwitch\('includeCaught', false\)/],
    },
    'captureLocalVariables.reportSite': {
      safe: 'off',
      why: 'default ON inside an opt-in feature; invalid is OFF + onError',
      check: ['node', /readSwitch\('reportSite', true\)/],
    },
    'traceResponse.serverTiming': {
      safe: 'off',
      why: 'exposes trace ids: strictly `=== true`',
      check: ['node', /config\.serverTiming === true/],
    },
    'traceResponse.traceresponse': {
      safe: 'off',
      why: 'exposes trace ids: strictly `=== true`',
      check: ['node', /config\.traceresponse === true/],
    },
    'traceResponse.exposeTraceresponse': {
      safe: 'off',
      why: 'widens CORS exposure: strictly `=== true`',
      check: ['node', /config\.exposeTraceresponse === true/],
    },
  };
  /** Object-typed properties that are injected SEAMS / test doubles, not option bags. */
  const NOT_BAGS = new Set(['document', 'deviceIdEnv', 'cpuProfiler']);

  it('every boolean inside an option bag is classified in NESTED and its read is pinned in the source', () => {
    const unclassified = new Set<string>();
    for (const [pkg, file, name] of INTERFACES) {
      for (const key of nestedBooleanKeys(pkg, file, name)) {
        if (!NOT_BAGS.has(key.split('.')[0] as string) && !(key in NESTED)) {
          unclassified.add(`${pkg}:${name}.${key}`);
        }
      }
    }
    expect(
      [...unclassified],
      'classify the nested option in NESTED (safe side + the source read that implements it)',
    ).toEqual([]);
    const unread: string[] = [];
    for (const [key, entry] of Object.entries(NESTED)) {
      const [pkg, pattern] = entry.check;
      const found = sourceFiles(join(packages, pkg, 'src')).some((file) =>
        pattern.test(readFileSync(file, 'utf8')),
      );
      if (!found) {
        unread.push(`${key}: ${String(pattern)} not found in packages/${pkg}/src`);
      }
    }
    expect(unread).toEqual([]);
  });

  it('NESTED names no option that no longer exists', () => {
    const live = new Set(
      INTERFACES.flatMap(([pkg, file, name]) => nestedBooleanKeys(pkg, file, name)),
    );
    expect(Object.keys(NESTED).filter((key) => !live.has(key))).toEqual([]);
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
