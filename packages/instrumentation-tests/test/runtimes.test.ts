import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resolveTsx, runtimeTargets } from './runtimes';

// These pin the RESOLUTION of the harness's own tooling, which had no test and failed silently.
//
// `tsx` is a devDependency of THIS package, so under pnpm its bin lives in this package's own
// `node_modules/.bin` — not the workspace root's. The harness looked only at the root, found a stale
// binary left there by an older install on one developer's machine, and on CI (where `git clean -ffdx`
// removes it) found nothing. The node target then reported itself "unavailable" and its whole
// instrumentation suite was SKIPPED: CI ran 133 e2e tests where a developer ran 195, and went green.
//
// Nothing could have caught that from inside a test run, because the skip is what a genuinely absent
// runtime is supposed to do. So the invariant is asserted here instead: node is not optional.

describe('resolveTsx', () => {
  it('finds a tsx that actually runs', () => {
    const bin = resolveTsx();
    expect(bin, 'tsx is a devDependency of this package; it must always resolve').toBeDefined();
    expect(() => execFileSync(bin as string, ['--version'], { stdio: 'ignore' })).not.toThrow();
  });

  it('resolves it inside THIS package, not only at the workspace root', () => {
    // The root copy is incidental — a hoist, or a leftover. The package's own is the one pnpm
    // guarantees, and depending on the other is what broke CI.
    expect(resolveTsx()).toContain('packages/instrumentation-tests/node_modules/.bin/tsx');
  });
});

describe('runtimeTargets', () => {
  it('always has node available — it is the guaranteed target', () => {
    const node = runtimeTargets().find((t) => t.name === 'node');
    expect(node?.bin, 'node unavailable means its e2e suite silently skips').toBeDefined();
  });
});
