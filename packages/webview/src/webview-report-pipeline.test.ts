import { createReportingRequest, type ReportingRequest } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import type { HostBridge } from './host-bridge';
import type { EntryMessage, ReportMessage } from './protocol';
import { createWebViewReportPipeline } from './webview-report-pipeline';

function recordingBridge() {
  const posted: string[] = [];
  const bridge: HostBridge = { available: true, post: (r) => posted.push(r) };
  return { bridge, msgs: () => posted.map((r) => JSON.parse(r) as EntryMessage | ReportMessage) };
}

const aRequest = (summary: string): ReportingRequest =>
  createReportingRequest({ source: { type: 'crash' }, summary, id: 'inc-1' });

const opts = (bridge: HostBridge, reportTrigger: boolean) => ({
  bridge,
  reportTriggerEnabled: () => reportTrigger,
  seq: (() => {
    let n = 0;
    return () => n++;
  })(),
  wallNow: () => 5000,
  now: () => 3,
  timeOrigin: 1000,
});

describe('createWebViewReportPipeline', () => {
  it('always streams the incident as a crash ENTRY (timeline), regardless of the gate', async () => {
    const { bridge, msgs } = recordingBridge();
    const pipe = createWebViewReportPipeline(opts(bridge, false));
    const result = await pipe.report(aRequest('boom'));

    const entry = msgs().find((m): m is EntryMessage => m.k === 'entry');
    expect(entry?.t).toBe('crash');
    expect(JSON.stringify(entry?.p)).toContain('boom'); // the serialized report metadata
    expect(entry).toMatchObject({ ts: 5000, mono: 3, o: 1000 });
    expect(result).toEqual({ ok: true });
  });

  it('does NOT emit a report trigger when the gate is OFF (D5 default)', async () => {
    const { bridge, msgs } = recordingBridge();
    const pipe = createWebViewReportPipeline(opts(bridge, false));
    await pipe.report(aRequest('boom'));
    expect(msgs().some((m) => m.k === 'report')).toBe(false); // entry only, no bug opened
  });

  it('ALSO emits a report trigger when the gate is ON (native opens a bug)', async () => {
    const { bridge, msgs } = recordingBridge();
    const pipe = createWebViewReportPipeline(opts(bridge, true));
    await pipe.report(aRequest('kaboom'));
    const m = msgs();
    expect(m.some((x) => x.k === 'entry' && x.t === 'crash')).toBe(true); // still streams the entry
    const report = m.find((x): x is ReportMessage => x.k === 'report');
    expect(report?.t).toBe('crash');
    expect(JSON.stringify(report?.p)).toContain('kaboom');
  });

  it('reads the gate dynamically per report (native may toggle reportTrigger mid-session)', async () => {
    const { bridge, msgs } = recordingBridge();
    let enabled = false;
    const pipe = createWebViewReportPipeline({
      ...opts(bridge, false),
      reportTriggerEnabled: () => enabled,
    });
    await pipe.report(aRequest('a'));
    enabled = true;
    await pipe.report(aRequest('b'));
    expect(msgs().filter((x) => x.k === 'report')).toHaveLength(1); // only the second triggered a bug
  });

  it('stamps `red` on BOTH the crash entry and the report trigger from redacted() (D3)', async () => {
    const { bridge, msgs } = recordingBridge();
    const pipe = createWebViewReportPipeline({ ...opts(bridge, true), redacted: () => true });
    await pipe.report(aRequest('boom'));
    const m = msgs();
    expect(m.find((x): x is EntryMessage => x.k === 'entry')?.red).toBe(true); // a report handler ran
    expect(m.find((x): x is ReportMessage => x.k === 'report')?.red).toBe(true);
  });

  it('defaults `red` to false when no redacted() is injected (native redacts the report)', async () => {
    const { bridge, msgs } = recordingBridge();
    const pipe = createWebViewReportPipeline(opts(bridge, true));
    await pipe.report(aRequest('boom'));
    expect(msgs().find((x): x is EntryMessage => x.k === 'entry')?.red).toBe(false);
    expect(msgs().find((x): x is ReportMessage => x.k === 'report')?.red).toBe(false);
  });

  it('defaults wall←Date.now, mono←performance.now, o←performance.timeOrigin (not swapped)', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(7777);
    vi.spyOn(performance, 'now').mockReturnValue(33);
    const { bridge, msgs } = recordingBridge();
    const pipe = createWebViewReportPipeline({
      bridge,
      reportTriggerEnabled: () => false,
      seq: () => 0,
    });
    await pipe.report(aRequest('x'));
    const entry = msgs().find((m): m is EntryMessage => m.k === 'entry');
    expect(entry?.ts).toBe(7777); // Date.now()
    expect(entry?.mono).toBe(33); // performance.now() — a wall/mono or now/timeOrigin swap fails this
    expect(entry?.o).toBe(performance.timeOrigin); // performance.timeOrigin
    vi.restoreAllMocks();
  });
});
