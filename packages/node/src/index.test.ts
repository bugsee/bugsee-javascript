import { describe, expect, it } from 'vitest';
import * as publicApi from './index';

/**
 * The public export surface of `@bugsee/node`.
 *
 * TWO reasons this exists, and the second one is why it was written:
 *
 * 1. Removing or renaming anything below is a BREAKING change for consumers, and nothing else in this
 *    package would notice — every other test imports the module it is testing directly, never the
 *    barrel. This pins the surface so a rename has to be a deliberate edit here too.
 *
 * 2. Because no test loaded `src/index.ts`, the coverage gate treated it as an untested file and
 *    counted its ~19 re-export statements as uncovered — but only on CI. Locally v8 reported the file
 *    as having no executable lines at all and it passed at 100%; on a cold CI transform the same file
 *    counted, and the package failed at 96.52%. A gate that depends on transform-cache warmth is not a
 *    gate. Loading the barrel makes the file genuinely covered, identically in both environments.
 *
 * 22 other packages have a barrel no test imports; only this one carries enough re-exports to push the
 * total past the threshold. If another starts failing this way, this is the fix.
 */

/** Every VALUE the package exports (types are erased and cannot be asserted at runtime). */
const EXPECTED_EXPORTS = [
  'PROFILING_OPTION_DEFINITIONS',
  'ProfilingOption',
  'RequestContextStoreToken',
  'buildNodeEnvironment',
  'createCpuProfiler',
  'createEventLoopWatchdog',
  'createGuardedSystemMetricsSampler',
  'createHangDetectionProvider',
  'createHttpServerInterceptor',
  'createNodeHttpInterceptor',
  'createNodeRequestContextStore',
  'createNodeSystemEventsSource',
  'createNodeSystemMetricsSampler',
  'createProfilingController',
  'createUncaughtExceptionProvider',
  'createUnhandledRejectionProvider',
  'defaultShouldReport',
  'evaluateHang',
  'getActiveServerSpan',
  'guarded',
  'launch',
  'launchCore',
  'neverThrow',
  'openServerContext',
  'openServerRequest',
  'realSystemProbe',
  'runServerRequest',
  'startServerSpan',
  'wrapFetchHandler',
] as const;

describe('@bugsee/node public export surface', () => {
  it('exports exactly the documented set — no more, no fewer', () => {
    // Both directions matter: a MISSING export breaks a consumer, and an UNINTENDED one becomes public
    // API the moment it ships, which is far harder to take back than to never publish.
    expect(Object.keys(publicApi).sort()).toEqual([...EXPECTED_EXPORTS].sort());
  });

  it('every export is actually defined — a barrel can re-export a name that no longer exists', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(publicApi[name as keyof typeof publicApi], `${name} is undefined`).toBeDefined();
    }
  });

  it('re-exports the two @bugsee/core guards the backend adapters rely on', () => {
    // These are deliberately re-exported so an adapter can guard its own pre-request work without
    // taking a direct @bugsee/core dependency (see the note in index.ts). Dropping them would push a
    // core dependency onto seven adapter packages.
    expect(typeof publicApi.guarded).toBe('function');
    expect(typeof publicApi.neverThrow).toBe('function');
  });

  it('exposes launch and launchCore as the two entry points', () => {
    expect(typeof publicApi.launch).toBe('function');
    expect(typeof publicApi.launchCore).toBe('function');
  });
});
