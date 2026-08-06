import type { ReportingRequest } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { decodeReport } from './protocol';
import { createElectronRendererReportPipeline } from './renderer-report-pipeline';

// R2 (docs/design/electron-renderer-incident-convergence.md §4.1). The renderer must FORWARD incidents to
// main, never upload them itself — see docs/review/electron.md SEV1 #2.
const request = (over: Partial<ReportingRequest> = {}): ReportingRequest =>
  ({
    source: { mechanism: 'uncaught' },
    report: { type: 'crash', summary: 'renderer boom' },
    ...over,
  }) as ReportingRequest;

describe('createElectronRendererReportPipeline', () => {
  const pipeline = (
    over: Partial<Parameters<typeof createElectronRendererReportPipeline>[0]> = {},
  ) => {
    const posted: string[] = [];
    const errors: unknown[] = [];
    const p = createElectronRendererReportPipeline({
      post: (raw) => posted.push(raw),
      canDeliver: () => true,
      wallNow: () => 1234,
      onError: (e) => errors.push(e),
      ...over,
    });
    return { p, posted, errors };
  };

  it('posts the incident as a decodable report message', async () => {
    const { p, posted } = pipeline();
    expect(await p.report(request())).toEqual({ ok: true });
    expect(posted).toHaveLength(1);
    const decoded = decodeReport(posted[0] as string);
    expect(decoded?.report.summary).toBe('renderer boom');
    expect(decoded?.timestamp).toBe(1234);
  });

  it('PRESERVES the mechanism — the attribution main must not re-file away', () => {
    const { p, posted } = pipeline();
    void p.report(request({ source: { mechanism: 'unhandledrejection' } } as never));
    expect(decodeReport(posted[0] as string)?.source.mechanism).toBe('unhandledrejection');
  });

  it('never posts anything resembling a capture entry', () => {
    // Design review SEV1-1: an incident forwarded as an `entry` lands in main's capture store and yields a
    // second, array-shaped crash.json that pollutes every later bundle for the rolling window.
    const { p, posted } = pipeline();
    void p.report(request());
    const parsed = JSON.parse(posted[0] as string) as { k: string; t?: unknown };
    expect(parsed.k).toBe('report');
    expect(parsed.t).toBeUndefined();
  });

  it('resolves { ok: false } and posts NOTHING when the bridge cannot deliver', async () => {
    // Honest failure semantics: an app awaiting logException must not be told an incident was delivered when
    // no bridge received it.
    const { p, posted } = pipeline({ canDeliver: () => false });
    expect(await p.report(request())).toEqual({ ok: false });
    expect(posted).toEqual([]);
  });

  it('contains a throwing post: reports failure, never propagates into the host', async () => {
    const { p, errors } = pipeline({
      post: () => {
        throw new Error('bridge gone');
      },
    });
    await expect(p.report(request())).resolves.toEqual({ ok: false });
    expect(String(errors[0])).toContain('bridge gone');
  });
});
