import { describe, expect, it } from 'vitest';
import * as mod_middleware from './middleware';
import * as mod_setup from './setup';

// WAVE 2.2 — the host-boundary contract for @bugsee/koa.
//
// The rule (Wave 2.1): every host-facing entry point is wrapped, so an SDK-internal failure never becomes
// the application's failure. Enforced here rather than re-derived, because the review found it applied where
// someone remembered and skipped where they did not — and the same file found real defects in every frontend
// adapter it was added to.
//
// The seam that matters most for a backend adapter is `setup*`: it runs at SERVER BOOTSTRAP, so a throw
// there does not cost one report, it stops the application starting at all. The app/server object it walks
// is entirely host-supplied.
//
// Two halves: CONTAINMENT (drive every entry with a hostile host object), and COMPLETENESS (enumerate the
// exported surface so a new export without a containment test fails this file by name).

/** A host app/server whose every method throws — the framework misbehaving, or a version we mis-guessed. */
const hostileApp = (): never =>
  new Proxy({} as never, {
    get() {
      return () => {
        throw new Error('host app blew up');
      };
    },
  });

describe('the host-boundary contract (Wave 2.2)', () => {
  it('setupKoa does not throw out of server bootstrap on a hostile app', () => {
    expect(() => mod_setup.setupKoa(hostileApp(), {})).not.toThrow();
  });

  it('bugseeKoa returns usable middleware and does not throw when built', () => {
    expect(() => mod_middleware.bugseeKoa({})).not.toThrow();
  });

  it('covers EVERY host-facing export — adding one without a containment test fails here', () => {
    const owned: Record<string, unknown> = { ...mod_middleware, ...mod_setup };
    const functions = Object.keys(owned).filter((n) => typeof owned[n] === 'function');
    const covered = new Set([
      'setupKoa',
      'bugseeKoa',
      'defaultShouldReport',
      'httpErrorStatus',
      'requestName',
    ]);
    expect(functions.filter((n) => !covered.has(n)).sort()).toEqual([]);
  });
});
