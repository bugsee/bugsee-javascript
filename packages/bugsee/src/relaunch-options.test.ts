import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAUNCH_KEPT_OPTIONS } from '@bugsee/core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// R2P-3: `relaunch()` starts from DEFAULTS for Bugsee behaviour options but must keep the integration seams
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
  const program = ts.createProgram([target], { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(target);
  if (source === undefined) {
    throw new Error(`cannot read ${target}`);
  }
  const declaration = source.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  );
  if (declaration === undefined) {
    throw new Error(`${name} not found in ${target}`);
  }
  return checker
    .getPropertiesOfType(checker.getTypeAtLocation(declaration))
    .map((property) => property.getName());
}

/**
 * Bugsee BEHAVIOUR options, and per-launch values (secrets, nonces, hooks): correctly RESET to their defaults
 * by `relaunch()` (Android and iOS start a relaunch from defaults too). A key's presence here is the decision
 * "this is not deployment identity and not an integration seam". Notes on the ones that look otherwise:
 *  - `lifecycleEventsListener` is held on the carrier slot (`setProcessLifecycleEventsListener`), so it
 *    survives a relaunch without being re-passed;
 *  - the Electron handles (`app`, `ipcMain`, `crashReporter`, `bridge`, `post`, `launch`, `onSessionId`,
 *    `nativeCrash`, `video`) belong to compositions that `relaunchWith` never re-runs (Electron has no
 *    `relaunch()`), and keeping them would pin Electron objects on `globalThis` for nothing;
 *  - `captureNonce`, `controlNonce`, `otelExportHeaders` and `otelExportUrl` are secrets or per-launch
 *    credentials: never kept (`setCarrierLastLaunch` stores only the kept list).
 */
const RESET_OPTIONS: readonly string[] = [
  'app',
  'bridge',
  'captureBreadcrumbs',
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
  'captureViewHierarchy',
  'controlNonce',
  'crashReporter',
  'crashReporterExtra',
  'detectCrashes',
  'detectHangs',
  'detectHttpErrors',
  'exitOnUncaught',
  'hangFairMs',
  'hangMediumMs',
  'hangSevereMs',
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
  'shutdownTimeoutMs',
  'startInBlackout',
  'traceInteractions',
  'traceNavigations',
  'tracePropagationOrigin',
  'tracePropagationTargets',
  'traceResponse',
  'unhandledRejections',
  'video',
];

describe('relaunch() option classification (R2P-3)', () => {
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
});
