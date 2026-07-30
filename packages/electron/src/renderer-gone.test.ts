import type { CrashpadSessionMarker, HarvestedDump } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { createRendererGoneHandler } from './renderer-gone';

// R4 (docs/design/electron-renderer-incident-convergence.md §4.4). A renderer killed by an OOM or a native
// crash never runs the JS that would forward its incident, so main synthesises it — claiming the minidump so
// the LIVE incident carries it, and falling back to what is available when no dump arrives.
const marker = {
  session: 's1',
  dumpDir: '/dumps',
  generation: 1,
} as unknown as CrashpadSessionMarker;
const dump = (name: string): HarvestedDump =>
  ({ name, data: new Uint8Array([1]) }) as HarvestedDump;

function harness(
  over: Partial<Parameters<typeof createRendererGoneHandler>[0]> = {},
  dumps: HarvestedDump[][] = [[]],
) {
  const submitted: Array<Record<string, unknown>> = [];
  const claimed: string[] = [];
  const fallbacks: string[] = [];
  const errors: unknown[] = [];
  let harvestCall = 0;
  const handler = createRendererGoneHandler({
    marker: () => marker,
    source: {
      harvest: () => dumps[Math.min(harvestCall++, dumps.length - 1)] ?? [],
      claim: (_m, name) => claimed.push(name),
    },
    submit: (i) => submitted.push(i as never),
    onFallback: (r) => fallbacks.push(r),
    sleep: () => Promise.resolve(),
    dumpWaitMs: 300,
    dumpPollMs: 100,
    onError: (e) => errors.push(e),
    ...over,
  });
  return { handler, submitted, claimed, fallbacks, errors };
}

describe('createRendererGoneHandler — reason gating', () => {
  it('IGNORES clean-exit — synthesising here would manufacture crashes that never happened', async () => {
    const h = harness();
    await h.handler.handle(1, { reason: 'clean-exit' });
    expect(h.submitted).toEqual([]);
  });

  it('ignores an unrecognised reason rather than guessing', async () => {
    const h = harness();
    await h.handler.handle(1, { reason: 'something-new-from-electron' });
    expect(h.submitted).toEqual([]);
  });

  it('handles every genuine fault reason', async () => {
    for (const reason of [
      'crashed',
      'oom',
      'launch-failed',
      'integrity-failure',
      'abnormal-exit',
      'killed',
    ]) {
      const h = harness();
      await h.handler.handle(1, { reason });
      expect(h.submitted, reason).toHaveLength(1);
    }
  });

  it('carries the window id and exit code through', async () => {
    const h = harness();
    await h.handler.handle(42, { reason: 'oom', exitCode: 9 });
    expect(h.submitted[0]).toMatchObject({ windowId: 42, reason: 'oom', exitCode: 9 });
  });
});

describe('createRendererGoneHandler — claiming the minidump', () => {
  it('claims a dump that APPEARS AFTER the crash, and attaches it', async () => {
    // Baseline harvest is empty, then `ours.dmp` lands → it is ours.
    const h = harness({}, [[], [dump('ours.dmp')]]);
    await h.handler.handle(1, { reason: 'crashed' });
    expect(h.claimed).toEqual(['ours.dmp']);
    expect(h.submitted[0]?.dump).toBeDefined();
    expect(h.fallbacks).toEqual([]);
  });

  it('does NOT claim a PRE-EXISTING dump — it belongs to another crash', async () => {
    // The harvest seam returns ALL completed dumps with no per-process/per-run filtering, and claim DELETES.
    // Taking a pre-existing one destroys another crash's evidence and misattributes it here
    // (code review SEV1-4). A stale dump left by an earlier fallback is the realistic case.
    const h = harness({}, [[dump('someone-elses.dmp')]]);
    await h.handler.handle(1, { reason: 'crashed' });
    expect(h.claimed).toEqual([]);
    expect(h.submitted[0]?.dump).toBeUndefined();
    expect(h.fallbacks).toEqual(['crashed']); // fell back rather than stealing it
  });

  it('two concurrent crashes never take the same dump', async () => {
    // claim() is exists-guarded and does not throw on a double-claim, so without in-flight bookkeeping both
    // incidents would silently carry one renderer's dump (code review SEV1-4b).
    let call = 0;
    const claimed: string[] = [];
    const handler = createRendererGoneHandler({
      marker: () => marker,
      source: {
        // Baselines empty for both, then ONE fresh dump visible to both waiters.
        harvest: () => (call++ < 2 ? [] : [dump('single.dmp')]),
        claim: (_m, name) => claimed.push(name),
      },
      submit: () => {},
      sleep: () => Promise.resolve(),
      dumpWaitMs: 100,
      dumpPollMs: 100,
    });
    await Promise.all([
      handler.handle(1, { reason: 'crashed' }),
      handler.handle(2, { reason: 'crashed' }),
    ]);
    expect(claimed).toEqual(['single.dmp']); // exactly once
  });

  it('WAITS for a dump Crashpad has not finished writing yet', async () => {
    // The real ordering: render-process-gone fires before the dump lands in completed/.
    const h = harness({}, [[], [], [dump('late.dmp')]]);
    await h.handler.handle(1, { reason: 'crashed' });
    expect(h.claimed).toEqual(['late.dmp']);
    expect(h.submitted[0]?.dump).toBeDefined();
  });

  it('claims BEFORE submitting, so recovery cannot double-report it', async () => {
    const order: string[] = [];
    let call = 0;
    const h = harness({
      source: {
        harvest: () => (call++ === 0 ? [] : [dump('x.dmp')]), // baseline empty, then ours
        claim: () => order.push('claim'),
      },
      submit: () => order.push('submit'),
    });
    await h.handler.handle(1, { reason: 'crashed' });
    expect(order).toEqual(['claim', 'submit']);
  });

  it('does not attempt a claim for a reason Crashpad does not dump for', async () => {
    const h = harness({}, [[], [dump('a.dmp')]]);
    await h.handler.handle(1, { reason: 'oom' });
    expect(h.claimed).toEqual([]);
    expect(h.submitted[0]?.dump).toBeUndefined();
  });
});

describe('createRendererGoneHandler — fallback to what is available', () => {
  it('still submits the incident when no dump ever arrives', async () => {
    const h = harness({}, [[]]);
    await h.handler.handle(1, { reason: 'crashed' });
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]?.dump).toBeUndefined();
    expect(h.fallbacks).toEqual(['crashed']);
  });

  it('does NOT claim on fallback, so a late dump can still reach recovery', async () => {
    const h = harness({}, [[]]);
    await h.handler.handle(1, { reason: 'crashed' });
    expect(h.claimed).toEqual([]);
  });

  it('submits with the dump even when the claim throws — a duplicate beats a lost crash', async () => {
    let call = 0;
    const h = harness({
      source: {
        harvest: () => (call++ === 0 ? [] : [dump('x.dmp')]),
        claim: () => {
          throw new Error('unlink failed');
        },
      },
    });
    await h.handler.handle(1, { reason: 'crashed' });
    expect(h.submitted[0]?.dump).toBeDefined();
    expect(String(h.errors[0])).toContain('unlink failed');
  });

  it('submits without a dump when harvesting throws', async () => {
    const h = harness({
      source: {
        harvest: () => {
          throw new Error('readdir failed');
        },
        claim: () => {},
      },
    });
    await h.handler.handle(1, { reason: 'crashed' });
    expect(h.submitted).toHaveLength(1);
    expect(String(h.errors[0])).toContain('readdir failed');
  });

  it('submits without a dump when there is no session marker yet', async () => {
    const h = harness({ marker: () => undefined });
    await h.handler.handle(1, { reason: 'crashed' });
    expect(h.submitted).toHaveLength(1);
    expect(h.claimed).toEqual([]);
  });

  it('never throws into Electron’s event dispatch, even if submit itself throws', async () => {
    const h = harness({
      submit: () => {
        throw new Error('submit boom');
      },
    });
    await expect(h.handler.handle(1, { reason: 'oom' })).resolves.toBeUndefined();
    expect(String(h.errors[0])).toContain('submit boom');
  });

  it('does not hold the app open while waiting (the sleep handle is unref’d)', async () => {
    // The default sleep must unref its timer, or a pending wait would keep the process alive. The handler is
    // async and yields on the first harvest, so the assertion has to wait for it to reach the sleep.
    const unref = vi.fn();
    vi.stubGlobal(
      'setTimeout',
      vi.fn((cb: () => void) => {
        cb(); // fire immediately so the wait loop completes within the test
        return { unref };
      }),
    );
    const h = createRendererGoneHandler({
      marker: () => marker,
      source: { harvest: () => [], claim: () => {} },
      submit: () => {},
      dumpWaitMs: 1,
      dumpPollMs: 1,
    });
    await h.handle(1, { reason: 'crashed' });
    expect(unref).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('createRendererGoneHandler — a poll that throws after a good baseline', () => {
  it('reports the error and still submits (the outer guard, not the baseline one)', async () => {
    // The baseline harvest succeeds, so awaitDump's own catch does not fire; a LATER poll throwing must be
    // contained by the outer guard rather than costing us the incident.
    let call = 0;
    const submitted: unknown[] = [];
    const errors: unknown[] = [];
    const handler = createRendererGoneHandler({
      marker: () => marker,
      source: {
        harvest: () => {
          if (call++ === 0) return []; // baseline OK
          throw new Error('poll failed');
        },
        claim: () => {},
      },
      submit: (i) => submitted.push(i),
      onError: (e) => errors.push(e),
      sleep: () => Promise.resolve(),
      dumpWaitMs: 100,
      dumpPollMs: 100,
    });
    await handler.handle(1, { reason: 'crashed' });
    expect(submitted).toHaveLength(1);
    expect(String(errors[0])).toContain('poll failed');
  });
});

describe('createRendererGoneHandler — defaults', () => {
  it('uses a no-op onError when none is supplied (never throws outward)', async () => {
    const submitted: unknown[] = [];
    const handler = createRendererGoneHandler({
      marker: () => marker,
      source: {
        harvest: () => {
          throw new Error('boom');
        },
        claim: () => {},
      },
      submit: (i) => submitted.push(i),
      sleep: () => Promise.resolve(),
      dumpWaitMs: 0,
    });
    await expect(handler.handle(1, { reason: 'crashed' })).resolves.toBeUndefined();
    expect(submitted).toHaveLength(1); // still reported what was available
  });
});
