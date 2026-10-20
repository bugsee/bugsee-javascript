import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAUNCH_KEPT_OPTIONS } from '@bugsee/core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createSharedProgram, TS_PROGRAM_TEST_TIMEOUT_MS } from './ts-program-cache.test-helper';

// `relaunch()` starts from DEFAULTS for Bugsee behaviour options but must keep the integration seams
// AND the deployment identity (endpoint, app version, ...): forgetting one uploads to the default production
// endpoint or under the wrong app version. `RELAUNCH_KEPT_OPTIONS` (core `carrier.ts`) is the single source of
// truth for what is kept; THIS table makes a new option impossible to forget: every launch option of every
// platform must be classified here as RESET (a Bugsee behaviour option, correctly back to its default) or be
// in the kept list. Adding an option to any platform interface fails this test until it is classified.

const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every launch-options interface of every platform / entry, as [package dir, source file, interface]. */
const INTERFACES: Array<[string, string, string]> = [
  ['node', 'src/launch.ts', 'BugseeLaunchOptions'],
  ['browser', 'src/launch.ts', 'BugseeLaunchOptions'],
  ['webworker', 'src/launch.ts', 'BugseeWorkerLaunchOptions'],
  ['vercel-edge', 'src/launch.ts', 'BugseeEdgeLaunchOptions'],
  ['webview', 'src/launch.ts', 'BugseeWebViewLaunchOptions'],
  ['bugsee', 'src/launch.ts', 'BugseeLaunchOptionsWithPerformance'],
  ['bugsee', 'src/server-launch.ts', 'BugseeServerLaunchOptions'],
  ['electron', 'src/launch-main.ts', 'LaunchMainOptions'],
  ['electron', 'src/launch-renderer.ts', 'LaunchRendererOptions'],
  // Framework adapters and the remaining runtimes. The ones that only `extends` a platform interface
  // add no key, but they are listed so the day one adds an option it is classified here. A name that is a
  // function resolves to the type of its `options` (second) parameter; a type alias resolves to its object constituents.
  ['nextjs', 'src/client.ts', 'NextjsClientOptions'],
  ['nextjs', 'src/server.ts', 'NextjsServerOptions'],
  ['nextjs', 'src/edge.ts', 'NextjsEdgeOptions'],
  ['nuxt', 'src/client.ts', 'InstallBugseeClientOptions'],
  ['nuxt', 'src/nitro.ts', 'InstallBugseeNitroOptions'],
  ['nuxt', 'src/nitro-edge.ts', 'InstallBugseeNitroEdgeOptions'],
  ['remix', 'src/client.ts', 'RemixClientOptions'],
  ['remix', 'src/server.ts', 'RemixServerOptions'],
  ['sveltekit', 'src/client.ts', 'SvelteKitClientOptions'],
  ['sveltekit', 'src/server.ts', 'SvelteKitServerOptions'],
  ['sveltekit', 'src/edge.ts', 'SvelteKitEdgeOptions'],
  ['astro', 'src/client.ts', 'AstroClientOptions'],
  ['astro', 'src/server.ts', 'AstroServerOptions'],
  ['astro', 'src/edge.ts', 'AstroEdgeOptions'],
  ['cloudflare', 'src/launch-config.ts', 'BugseeWorkerConfig'],
  ['cloudflare', 'src/launch.ts', 'launch'],
  ['bun', 'src/launch.ts', 'launch'],
  ['deno', 'src/launch.ts', 'launch'],
];

function optionKeys(pkg: string, file: string, name: string): string[] {
  const root = join(packages, pkg);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (configPath === undefined) {
    throw new Error(`no tsconfig for ${pkg}`);
  }
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const target = join(root, file);
  const program = createSharedProgram(target, parsed.options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(target);
  if (source === undefined) {
    throw new Error(`cannot read ${target}`);
  }
  const declaration = source.statements.find(
    (
      statement,
    ): statement is ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.FunctionDeclaration =>
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isFunctionDeclaration(statement)) &&
      statement.name?.text === name,
  );
  if (declaration === undefined) {
    throw new Error(`${name} not found in ${target}`);
  }
  let types: ts.Type[];
  if (ts.isFunctionDeclaration(declaration)) {
    const parameter = declaration.parameters[1];
    if (parameter === undefined) {
      throw new Error(`${name} in ${target} takes no options (second) parameter`);
    }
    types = [checker.getTypeAtLocation(parameter)];
  } else {
    types = [checker.getTypeAtLocation(declaration)];
  }
  // A union (a type alias such as the Cloudflare config) contributes its OBJECT members: a string or a callback
  // carries no option keys. `getNonNullableType` drops the `undefined` of an optional parameter.
  const objects = types
    .map((type) => checker.getNonNullableType(type))
    .flatMap((type) => (type.isUnion() ? type.types : [type]))
    .filter(
      (type) =>
        (type.flags & ts.TypeFlags.Object) !== 0 || (type.flags & ts.TypeFlags.Intersection) !== 0,
    )
    .filter((type) => type.getCallSignatures().length === 0);
  return [
    ...new Set(
      objects.flatMap((type) => checker.getPropertiesOfType(type).map((p) => p.getName())),
    ),
  ];
}

/**
 * Bugsee BEHAVIOUR options, and per-launch values (secrets, nonces, hooks): correctly RESET to their defaults
 * by `relaunch()` (Android and iOS start a relaunch from defaults too). A key's presence here is the decision
 * "this is not deployment identity and not an integration seam". Notes on the ones that look otherwise:
 *  - `lifecycleEventsListener` is held on the carrier slot (`setProcessLifecycleEventsListener`), so it
 *    survives a relaunch without being re-passed;
 *  - the Electron handles (`app`, `ipcMain`, `crashReporter`, `powerMonitor`, `screen`, `BrowserWindow`, `gpuInfoType`, `bridge`, `post`, `launch`, `onSessionId`,
 *    `nativeCrash`, `video`) belong to compositions that `relaunchWith` never re-runs (it re-runs the node
 *    launch, not `launchMain`), and keeping them would pin Electron objects on `globalThis` for nothing;
 *  - `appToken` (the Cloudflare and Nuxt adapters accept it inside their options object) is the token itself,
 *    which `setCarrierLastLaunch` stores separately as `lastLaunch.appToken`; it is never part of the kept options;
 *  - `onSpanProcessor` and `setupOtelProvider` (Next.js server) wire the Bugsee span processor into an OTel
 *    provider: the callback receives the NEW client's processor, and the provider is first-wins, so a relaunch
 *    re-supplies them with the new options instead of pinning the old callback (and the old processor) alive;
 *  - `injectTraceMeta` (Nuxt) and `flushTimeoutMs` (Nuxt edge) are adapter behaviour options consumed by the
 *    adapter's own installer, never by the platform launch a relaunch re-runs;
 *  - `instanceIdentity` (node) is a per-instance identity: a pinned one must never be shared by two instances,
 *    so a relaunch builds a fresh one;
 *  - `captureNonce`, `controlNonce`, `otelExportHeaders` and `otelExportUrl` are secrets or per-launch
 *    credentials: never kept (`setCarrierLastLaunch` stores only the kept list);
 *  - `systemTraceProducers` (node/bun/deno) holds STATEFUL producer instances: a producer's `start()` is a
 *    no-op while it is already started, so an instance still running on another client would silently no-op
 *    on the new one, and its trackers stay bound to the scheduler/onError of the launch that built them. A
 *    relaunch therefore builds the runtime's fresh default set;
 *  - `wrapSystemEventsSource` (node, set by `@bugsee/electron`'s `launchMain`) is a platform composition seam whose
 *    wrapper is bound to the launch's tracker and reporter. A node/umbrella `relaunch()` in an Electron main re-runs
 *    the NODE launch, so like `systemTraceProducers` it is not re-applied: the relaunched client has the plain node
 *    producers and events source (no `app_metrics`/`child_process_gone`), while the kept `hardwareExtras` keeps
 *    serving `hardware.gpu`.
 */
const RESET_OPTIONS: readonly string[] = [
  'BrowserWindow',
  'app',
  'appToken',
  'captureWindowEvents',
  'flushTimeoutMs',
  'gpuInfoType',
  'injectTraceMeta',
  'instanceIdentity',
  'onSpanProcessor',
  'setupOtelProvider',
  'bridge',
  'captureBreadcrumbs',
  'captureDiskSpace',
  'captureEnvironmentHints',
  'captureInteractions',
  'captureLocalVariables',
  'captureLogs',
  'captureLogsLevel',
  'captureNetwork',
  'captureNetworkBodies',
  'captureNetworkBodyWithoutType',
  'captureNetworkDefaultSanitizer',
  'captureNonce',
  'captureObscuring',
  'captureSourceContext',
  'captureSystemEvents',
  'captureSystemTraces',
  'captureUserIdle',
  'captureViewHierarchy',
  'controlNonce',
  'crashReporter',
  'crashReporterExtra',
  'detectCrashes',
  'detectHangs',
  'detectHttpErrors',
  'diskStatfs',
  'exitOnUncaught',
  'hangFairMs',
  'hangMediumMs',
  'hangSevereMs',
  'holdBlackout',
  'instrumentIncomingRequests',
  'ipcMain',
  'launch',
  'lifecycleEventsListener',
  'maxDataSize',
  'maxNetworkBodySize',
  'maxRecordingTime',
  'nativeCrash',
  'notifyFlushDelay',
  'onOtelSpanProcessor',
  'onSessionId',
  'otelConsume',
  'otelExportHeaders',
  'otelExportResource',
  'otelExportUrl',
  'pageName',
  'performanceFlushIntervalMs',
  'performanceMonitoring',
  'performanceSampleRate',
  'performanceUploadMode',
  'persistUserIdentifier',
  'post',
  'powerMonitor',
  'profiling',
  'profilingSamplingIntervalMicros',
  'propagateTrace',
  'replay',
  'reportDefaultBugPriority',
  'reportDefaultCrashPriority',
  'reportDefaultErrorPriority',
  'reportDescriptionRequired',
  'reportEmailRequired',
  'reportLabelsEnabled',
  'reportLabelsRequired',
  'reportPrioritySelectorEnabled',
  'reportSummaryRequired',
  'reportTrigger',
  'screen',
  'shutdownTimeoutMs',
  'startInBlackout',
  'systemTraceProducers',
  'traceInteractions',
  'traceNavigations',
  'tracePropagationOrigin',
  'tracePropagationTargets',
  'traceResponse',
  'unhandledRejections',
  'video',
  'wrapSystemEventsSource',
];

// Builds a TypeScript program per platform interface: far slower on a shared CI runner than locally.
describe('relaunch() option classification', {
  timeout: TS_PROGRAM_TEST_TIMEOUT_MS,
}, () => {
  const all = new Map<string, string[]>();
  for (const [pkg, file, name] of INTERFACES) {
    for (const key of optionKeys(pkg, file, name)) {
      all.set(key, [...(all.get(key) ?? []), `${pkg}:${name}`]);
    }
  }

  it('classifies EVERY launch option of EVERY platform as kept or reset', () => {
    const unclassified = [...all.keys()]
      .filter((key) => !RELAUNCH_KEPT_OPTIONS.includes(key) && !RESET_OPTIONS.includes(key))
      .sort();
    expect(unclassified, 'classify these in RELAUNCH_KEPT_OPTIONS or RESET_OPTIONS').toEqual([]);
  });

  it('has no option both kept and reset', () => {
    expect(RESET_OPTIONS.filter((key) => RELAUNCH_KEPT_OPTIONS.includes(key))).toEqual([]);
  });

  it('names no stale option: every classified key still exists on some platform', () => {
    const stale = [...RELAUNCH_KEPT_OPTIONS, ...RESET_OPTIONS].filter((key) => !all.has(key));
    expect(stale).toEqual([]);
  });

  it('keeps the deployment identity on every platform that has it', () => {
    for (const key of ['endpoint', 'appVersion', 'appBuild', 'persist', 'recover']) {
      expect(RELAUNCH_KEPT_OPTIONS).toContain(key);
    }
  });

  it('reaches the framework adapters and the Bun / Deno / Cloudflare launches', () => {
    expect(all.get('onSpanProcessor')).toContain('nextjs:NextjsServerOptions');
    expect(all.get('setupOtelProvider')).toContain('nextjs:NextjsServerOptions');
    expect(all.get('injectTraceMeta')).toContain('nuxt:InstallBugseeNitroOptions');
    expect(all.get('flushTimeoutMs')).toContain('nuxt:InstallBugseeNitroEdgeOptions');
    expect(all.get('appToken')).toContain('cloudflare:BugseeWorkerConfig');
    expect(all.get('transport')).toEqual(expect.arrayContaining(['bun:launch', 'deno:launch']));
    expect(all.get('transport')).toContain('cloudflare:launch');
    expect(all.get('endpoint')).toEqual(
      expect.arrayContaining(['astro:AstroServerOptions', 'remix:RemixServerOptions']),
    );
  });

  it('does not keep a per-instance identity across a relaunch', () => {
    expect(RELAUNCH_KEPT_OPTIONS).not.toContain('instanceIdentity');
    expect(RESET_OPTIONS).toContain('instanceIdentity');
  });
});
