import { relative, sep } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createInstanceLayout } from './instance-layout';
import { DEFAULT_PATIENT_MS, isSiblingDead } from './liveness';

/**
 * Property-based tests for multi-instance disk coexistence.
 *
 * Two decisions here are destructive when wrong, and neither is recoverable:
 *
 *  - two live instances resolving to the SAME subtree interleave their appends into one another's files;
 *  - declaring a LIVE sibling dead deletes its capture out from under it. That is not hypothetical — the
 *    comment on `isSiblingDead` records it happening to a real child process under a real SIGSTOP, after
 *    which every write failed ENOENT forever with nothing recreating the tree.
 *
 * So both are stated as invariants over generated identities and clock positions rather than as examples.
 */

describe('instance layout (fuzz)', () => {
  const identity = fc.record({
    pid: fc.integer({ min: 1, max: 4_194_304 }), // a plausible pid range, incl. 32-bit max
    threadId: fc.integer({ min: 0, max: 64 }), // 0 = main thread
    nonce: fc.stringMatching(/^[0-9a-f]{8}$/),
  });

  /** Two instances differing in ANY identity component must not share a subtree. */
  it('gives distinct identities distinct subtrees', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^\/[a-z][a-z0-9/_-]{2,20}$/),
        identity,
        identity,
        (dataDir, a, b) => {
          fc.pre(a.pid !== b.pid || a.threadId !== b.threadId || a.nonce !== b.nonce);
          const left = createInstanceLayout(dataDir, { ...a, nonce: () => a.nonce });
          const right = createInstanceLayout(dataDir, { ...b, nonce: () => b.nonce });

          expect(left.instanceId).not.toBe(right.instanceId);
          expect(left.root).not.toBe(right.root);
          // Not merely different roots: neither may be a PREFIX of the other, or a recursive sweep of one
          // would take the other's subtree with it.
          expect(left.root.startsWith(`${right.root}${sep}`)).toBe(false);
          expect(right.root.startsWith(`${left.root}${sep}`)).toBe(false);
          for (const dir of [left.captureDir, left.pendingDir, left.incidentsDir, left.liveFile]) {
            expect(dir.startsWith(`${right.root}${sep}`)).toBe(false);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('keeps every path inside the instance root', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\/[a-z][a-z0-9/_-]{2,20}$/), identity, (dataDir, id) => {
        const layout = createInstanceLayout(dataDir, { ...id, nonce: () => id.nonce });
        for (const path of [
          layout.captureDir,
          layout.pendingDir,
          layout.incidentsDir,
          layout.liveFile,
          layout.ownerFile,
        ]) {
          expect(path.startsWith(`${layout.root}${sep}`), `${path} escaped the root`).toBe(true);
          // No traversal component may appear — the subtree must stay addressable as one unit.
          expect(path.split(sep)).not.toContain('..');
        }
        // Containment via `relative`, not `startsWith`: `join` NORMALIZES, so a `dataDir` of `/a//`
        // yields a root of `/a/<id>` which does not literally start with the string passed in. The
        // claim is that the root is under the directory, not that it is spelled the same way.
        const fromDataDir = relative(dataDir, layout.root);
        expect(fromDataDir.startsWith('..'), `${layout.root} is not under ${dataDir}`).toBe(false);
        expect(fromDataDir).toBe(layout.instanceId);
      }),
      { numRuns: 500 },
    );
  });

  it('derives the id from all three identity components', () => {
    fc.assert(
      fc.property(identity, (id) => {
        const layout = createInstanceLayout('/data', { ...id, nonce: () => id.nonce });
        // Each component is present and separable, so a peer reading the directory name can attribute it.
        expect(layout.instanceId).toBe(`${id.pid}-${id.threadId}-${id.nonce}`);
        expect(layout.pid).toBe(id.pid);
        expect(layout.threadId).toBe(id.threadId);
      }),
      { numRuns: 300 },
    );
  });
});

describe('isSiblingDead (fuzz)', () => {
  const heartbeatAge = fc.integer({ min: -1000, max: 10 * DEFAULT_PATIENT_MS });
  const patient = fc.integer({ min: 1, max: DEFAULT_PATIENT_MS });
  const now = fc.integer({ min: 0, max: 2 ** 40 });

  /** A dead PROCESS is reclaimable immediately — that is the signal the whole scheme rests on. */
  it('declares a subtree dead whenever the owning process is gone', () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 2 ** 40 }), { nil: undefined }),
        now,
        patient,
        fc.option(fc.integer({ min: 0, max: 64 }), { nil: undefined }),
        (liveMtimeMs, nowMs, patientMs, threadId) => {
          expect(isSiblingDead(false, liveMtimeMs, nowMs, patientMs, threadId)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  /**
   * THE regression this rule exists for. A MAIN-thread owner whose process is alive is never declared
   * dead, however stale its heartbeat — because the heartbeat cannot tell "frozen" from "gone" and
   * `kill(pid,0)` already said the process exists.
   *
   * Frozen is not exotic: `docker pause`, a VM suspend, a debugger break, a death-spiral GC, or the
   * blocked event loop this SDK ships ANR detection for. Generated across the whole staleness range,
   * including absurdly stale, because "however old" is the actual claim.
   */
  it('never reclaims a live MAIN-thread instance, however stale its heartbeat', () => {
    fc.assert(
      fc.property(now, heartbeatAge, patient, (nowMs, age, patientMs) => {
        for (const threadId of [0, undefined]) {
          expect(
            isSiblingDead(true, nowMs - age, nowMs, patientMs, threadId),
            `main-thread owner (threadId ${threadId}) reclaimed after ${age}ms`,
          ).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  // An instance that has not written its first heartbeat is still ARMING, not dead. Reclaiming it would
  // race every launch against its own startup.
  it('never reclaims a live instance that has no heartbeat yet', () => {
    fc.assert(
      fc.property(now, patient, fc.integer({ min: 0, max: 64 }), (nowMs, patientMs, threadId) => {
        expect(isSiblingDead(true, undefined, nowMs, patientMs, threadId)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * A WORKER-thread owner stays reclaimable: a live pid says nothing about whether THAT THREAD lives, and
   * its heartbeat runs on a worker that dies with it. The verdict is exactly the staleness comparison —
   * checked at the boundary too, since `>` vs `>=` decides the fate of a subtree exactly at the window.
   */
  it('reclaims a live-pid WORKER instance exactly when its heartbeat exceeds the window', () => {
    fc.assert(
      fc.property(
        now,
        patient,
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: -2, max: 2 }),
        (nowMs, patientMs, threadId, delta) => {
          // Ages straddling the window: patientMs-2 … patientMs+2.
          const age = patientMs + delta;
          expect(isSiblingDead(true, nowMs - age, nowMs, patientMs, threadId)).toBe(
            age > patientMs,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  // Totality-ish: the verdict is a boolean for every input, including a heartbeat stamped in the FUTURE
  // (clock skew between a container and its host, or a file copied with its mtime).
  it('returns a verdict for any clock relationship, including a future heartbeat', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 0, max: 2 ** 40 }),
        now,
        patient,
        fc.option(fc.integer({ min: 0, max: 64 }), { nil: undefined }),
        (alive, liveMtimeMs, nowMs, patientMs, threadId) => {
          const verdict = isSiblingDead(alive, liveMtimeMs, nowMs, patientMs, threadId);
          expect(typeof verdict).toBe('boolean');
          // A heartbeat from the future is never grounds for reclamation while the process lives.
          if (alive && liveMtimeMs > nowMs) {
            expect(verdict).toBe(false);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
