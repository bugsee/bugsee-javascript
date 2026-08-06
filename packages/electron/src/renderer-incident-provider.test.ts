import type { Client, HarvestedDump, ReportingRequest } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { RendererIncidentProvider } from './renderer-incident-provider';

// The main-side submit seam for renderer incidents (R3/R4). It is a conduit, not a detector: registering it
// is what makes the feature live, and it is the ONE public path that submits a ReportingRequest without
// re-filing it through logException (which would turn a renderer crash into a handled, main-stacked error).
const started = (over: ConstructorParameters<typeof RendererIncidentProvider>[0] = {}) => {
  const submitted: ReportingRequest[] = [];
  const provider = new RendererIncidentProvider(over);
  provider.start({} as Client, (r) => submitted.push(r));
  return { provider, submitted };
};
const decoded = (over: Record<string, unknown> = {}) => ({
  source: { type: 'crash', mechanism: 'uncaught' },
  report: { summary: 'renderer boom' },
  timestamp: 1,
  ...over,
});

describe('RendererIncidentProvider — forwarded incidents', () => {
  it('submits with the renderer’s source PRESERVED', () => {
    const { provider, submitted } = started();
    provider.submitForwarded(decoded() as never, 7);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.source).toEqual({ type: 'crash', mechanism: 'uncaught' });
  });

  it('stamps the faulting window id onto the report', () => {
    const { provider, submitted } = started();
    provider.submitForwarded(decoded() as never, 7);
    expect((submitted[0]?.report as unknown as Record<string, unknown>).electron_window_id).toBe(7);
  });

  it('is a no-op before start() and after stop() — the base sink is detached', () => {
    const provider = new RendererIncidentProvider();
    expect(() => provider.submitForwarded(decoded() as never, 1)).not.toThrow();
    const submitted: ReportingRequest[] = [];
    provider.start({} as Client, (r) => submitted.push(r));
    provider.stop();
    provider.submitForwarded(decoded() as never, 1);
    expect(submitted).toEqual([]);
  });

  it('names itself so a duplicate registration is detectable', () => {
    expect(new RendererIncidentProvider().name).toBe('electron-renderer-incident');
  });
});

describe('RendererIncidentProvider — rate limiting', () => {
  it('drops incidents beyond the per-window budget', () => {
    // A crash-looping or hostile renderer must not be able to flood the main session.
    const { provider, submitted } = started({ rateLimit: 3, now: () => 1000 });
    for (let i = 0; i < 10; i += 1) provider.submitForwarded(decoded() as never, 1);
    expect(submitted).toHaveLength(3);
  });

  it('budgets each window SEPARATELY — one noisy renderer must not silence another', () => {
    const { provider, submitted } = started({ rateLimit: 1, now: () => 1000 });
    provider.submitForwarded(decoded() as never, 1);
    provider.submitForwarded(decoded() as never, 1); // over budget for window 1
    provider.submitForwarded(decoded() as never, 2); // a different window still gets through
    expect(submitted).toHaveLength(2);
  });

  it('lets the window slide, so a long-lived app is not permanently muted', () => {
    let now = 1000;
    const { provider, submitted } = started({ rateLimit: 1, now: () => now });
    provider.submitForwarded(decoded() as never, 1);
    provider.submitForwarded(decoded() as never, 1);
    expect(submitted).toHaveLength(1);
    now += 61_000; // past the 60 s window
    provider.submitForwarded(decoded() as never, 1);
    expect(submitted).toHaveLength(2);
  });

  it('clears its bookkeeping on stop so a restart is not still rate-limited', () => {
    const now = 1000;
    const provider = new RendererIncidentProvider({ rateLimit: 1, now: () => now });
    const submitted: ReportingRequest[] = [];
    provider.start({} as Client, (r) => submitted.push(r));
    provider.submitForwarded(decoded() as never, 1);
    provider.stop();
    provider.start({} as Client, (r) => submitted.push(r));
    provider.submitForwarded(decoded() as never, 1);
    expect(submitted).toHaveLength(2);
  });
});

describe('RendererIncidentProvider — render-process-gone incidents', () => {
  const dump = (name: string): HarvestedDump =>
    ({ name, data: new Uint8Array([1, 2]) }) as HarvestedDump;

  it('submits a crash report naming the reason and window', () => {
    const { provider, submitted } = started();
    provider.submitGone({ reason: 'oom', windowId: 5 });
    const report = submitted[0]?.report as unknown as Record<string, unknown>;
    expect(submitted[0]?.source).toMatchObject({ type: 'crash' });
    expect(report.electron_gone_reason).toBe('oom');
    expect(report.electron_window_id).toBe(5);
    expect(String(report.summary)).toContain('oom');
  });

  it('carries the exit code when Electron supplied one, and omits it otherwise', () => {
    const { provider, submitted } = started();
    provider.submitGone({ reason: 'crashed', windowId: 1, exitCode: 139 });
    provider.submitGone({ reason: 'crashed', windowId: 2 });
    expect((submitted[0]?.report as unknown as Record<string, unknown>).electron_exit_code).toBe(
      139,
    );
    expect(
      (submitted[1]?.report as unknown as Record<string, unknown>).electron_exit_code,
    ).toBeUndefined();
  });

  it('attaches a claimed minidump as a report attachment', () => {
    const { provider, submitted } = started();
    provider.submitGone({ reason: 'crashed', windowId: 1, dump: dump('r.dmp') });
    const attachments = (submitted[0]?.report as { attachments?: Array<{ name: string }> })
      .attachments;
    expect(attachments?.[0]?.name).toBe('r.dmp');
  });

  it('omits attachments entirely when no dump was claimed', () => {
    const { provider, submitted } = started();
    provider.submitGone({ reason: 'oom', windowId: 1 });
    expect((submitted[0]?.report as { attachments?: unknown }).attachments).toBeUndefined();
  });

  it('rate-limits gone incidents too — a crash loop must not flood', () => {
    const { provider, submitted } = started({ rateLimit: 2, now: () => 1000 });
    for (let i = 0; i < 5; i += 1) provider.submitGone({ reason: 'crashed', windowId: 1 });
    expect(submitted).toHaveLength(2);
  });
});

describe('RendererIncidentProvider — error containment', () => {
  it('never throws outward when the report sink throws', () => {
    const errors: unknown[] = [];
    const provider = new RendererIncidentProvider({ onError: (e) => errors.push(e) });
    provider.start({} as Client, () => {
      throw new Error('sink boom');
    });
    expect(() => provider.submitForwarded(decoded() as never, 1)).not.toThrow();
    expect(() => provider.submitGone({ reason: 'oom', windowId: 1 })).not.toThrow();
    expect(errors).toHaveLength(2);
  });

  it('swallows a sink failure silently when no onError is supplied', () => {
    const provider = new RendererIncidentProvider();
    provider.start({} as Client, () => {
      throw new Error('boom');
    });
    expect(() => provider.submitGone({ reason: 'oom', windowId: 1 })).not.toThrow();
  });
});
