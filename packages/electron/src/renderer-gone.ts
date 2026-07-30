import type { CrashpadSessionMarker, HarvestedDump } from '@bugsee/core';

// R4 — renderer killed before it could report anything
// (docs/design/electron-renderer-incident-convergence.md §4.4).
//
// A renderer that dies from an OOM, a GPU fault or a native crash never runs the JS that would forward its
// incident (R2). Main therefore watches `render-process-gone` and synthesises the incident itself, attributed
// to the session that already holds that renderer's streamed capture.
//
// REASON GATING. `render-process-gone` also fires on ordinary teardown. Synthesising an incident for a closed
// window would manufacture crashes that never happened, so only genuine faults are handled and `clean-exit`
// is always ignored.
//
// DUMP CLAIMING (decision, 2026-07-30). For a reason that produces a native dump we CLAIM the minidump
// ourselves so the live incident carries it — the live incident is the valuable one, because it also has the
// session's capture and context, which the next-launch recovery path reconstructs only partially. Claiming
// deletes the dump, so the recovery path cannot then double-report it.
//
// Crashpad writes asynchronously: at `render-process-gone` time the dump is usually NOT in `completed/` yet,
// so claiming needs a bounded wait. If the dump never appears within that window, or claiming throws, we fall
// back to reporting with WHAT IS AVAILABLE — the capture and the crash reason, without the dump — rather than
// losing the incident. See `onFallback` for the residual duplicate this can leave.

/** The `render-process-gone` details Electron passes (the subset we use). */
export interface RenderProcessGoneDetails {
  reason: string;
  exitCode?: number;
}

/**
 * Reasons that represent a genuine fault. `clean-exit` is deliberately absent.
 *
 * `crashed`, `oom` and `launch-failed` are Electron's fault reasons; `integrity-failure` and
 * `abnormal-exit` are included as faults too. `killed` is treated as a fault: a renderer killed by the OS
 * (commonly memory pressure) is a real end-user-visible failure.
 */
const FAULT_REASONS: ReadonlySet<string> = new Set([
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'abnormal-exit',
  'killed',
]);

/** Reasons for which Crashpad is expected to produce a minidump, so claiming is worth attempting. */
const DUMP_REASONS: ReadonlySet<string> = new Set([
  'crashed',
  'abnormal-exit',
  'integrity-failure',
]);

export interface RendererGoneHandlerOptions {
  /** The live session marker (session id + Crashpad dump dir) the incident is attributed to. */
  marker: () => CrashpadSessionMarker | undefined;
  /** The Crashpad seam — the SAME one the next-launch recovery uses, so a claim here removes it from there. */
  source: {
    harvest(marker: CrashpadSessionMarker): Promise<HarvestedDump[]> | HarvestedDump[];
    claim(marker: CrashpadSessionMarker, name: string): void;
  };
  /** Submit the synthesised incident (the R3 join, with the dump attached when one was claimed). */
  submit: (incident: {
    reason: string;
    exitCode?: number;
    windowId: number;
    dump?: HarvestedDump;
  }) => void;
  /**
   * Called instead of a dump-bearing submit when claiming did not succeed for a dump-producing reason.
   *
   * The incident is still submitted (with capture but no dump). The dump is deliberately NOT claimed, so if
   * Crashpad writes it after our window the next-launch recovery still delivers it — at the cost of a
   * possible second, dump-bearing incident for the same crash. Losing the crash entirely would be worse;
   * this seam exists so a host can observe how often it happens.
   */
  onFallback?: (reason: string) => void;
  /** How long to wait for Crashpad to finish writing, in ms. Default 2000. */
  dumpWaitMs?: number;
  /** Poll interval while waiting, in ms. Default 100. */
  dumpPollMs?: number;
  /** Sleep seam (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Internal-error sink; a failure here must never propagate into Electron's event dispatch. */
  onError?: (error: unknown) => void;
}

export interface RendererGoneHandler {
  /** Handle one `render-process-gone`. Resolves once the incident has been submitted (or ignored). */
  handle(windowId: number, details: RenderProcessGoneDetails): Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const handle = (
      globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }
    ).setTimeout(resolve, ms);
    (handle as { unref?: () => void }).unref?.(); // never hold the app open on our account
  });

/** Build the `render-process-gone` handler. */
export function createRendererGoneHandler(
  options: RendererGoneHandlerOptions,
): RendererGoneHandler {
  const waitMs = options.dumpWaitMs ?? 2000;
  const pollMs = options.dumpPollMs ?? 100;
  const sleep = options.sleep ?? defaultSleep;
  const onError = options.onError ?? ((): void => {});

  /** Poll for a dump belonging to this session, bounded by `waitMs`. Undefined if none arrives. */
  const awaitDump = async (marker: CrashpadSessionMarker): Promise<HarvestedDump | undefined> => {
    const deadline = waitMs;
    let waited = 0;
    for (;;) {
      const dumps = await options.source.harvest(marker);
      if (dumps.length > 0) {
        return dumps[0];
      }
      if (waited >= deadline) {
        return undefined;
      }
      await sleep(pollMs);
      waited += pollMs;
    }
  };

  return {
    async handle(windowId: number, details: RenderProcessGoneDetails): Promise<void> {
      try {
        if (!FAULT_REASONS.has(details.reason)) {
          return; // clean-exit and anything unrecognised: not a crash, do not manufacture one
        }
        const marker = options.marker();
        const base = {
          reason: details.reason,
          windowId,
          ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
        };
        if (marker === undefined || !DUMP_REASONS.has(details.reason)) {
          // No marker (main not launched / no dump dir), or a reason Crashpad does not dump for: report what
          // is available.
          options.submit(base);
          return;
        }
        let dump: HarvestedDump | undefined;
        try {
          dump = await awaitDump(marker);
        } catch (error) {
          onError(error); // a harvest failure must not cost us the incident
        }
        if (dump === undefined) {
          options.onFallback?.(details.reason);
          options.submit(base);
          return;
        }
        // Claim BEFORE submitting: the claim is what stops the next-launch recovery re-reporting this crash.
        // If the claim throws we still submit — with the dump — and accept a possible duplicate from
        // recovery rather than dropping a crash we already hold.
        try {
          options.source.claim(marker, dump.name);
        } catch (error) {
          onError(error);
        }
        options.submit({ ...base, dump });
      } catch (error) {
        onError(error);
      }
    },
  };
}
