import type { Client, CrashJson, ReportingRequest, Scheduler } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import type { CpuProfile } from './cpu-profiler';
import type {
  EventLoopWatchdog,
  EventLoopWatchdogDeps,
  HangLevel,
  HangThresholds,
} from './event-loop-watchdog';
import { createHangDetectionProvider } from './hang-detection-provider';

const exceptionOf = (r?: ReportingRequest) => (r?.report.crash as CrashJson | undefined)?.exception;
const T: HangThresholds = { fairMs: 3000, mediumMs: 5000, severeMs: 10_000 };
const fakeClient = {} as Client;
const noopScheduler: Scheduler = { setInterval: () => 'h', clearInterval: () => {} };

// A fake watchdog: captures the onHang callback so a test can drive a hang directly (the real worker/SAB
// behavior is covered in event-loop-watchdog.test.ts).
function fakeWatchdog() {
  const state: { onHang?: (l: HangLevel, d: number) => void; started: boolean; stopped: boolean } =
    {
      started: false,
      stopped: false,
    };
  const create = (deps: EventLoopWatchdogDeps): EventLoopWatchdog => {
    state.onHang = deps.onHang;
    return {
      start: () => {
        state.started = true;
      },
      stop: () => {
        state.stopped = true;
      },
    };
  };
  return {
    create,
    hang: (l: HangLevel, d: number) => state.onHang?.(l, d),
    started: () => state.started,
    stopped: () => state.stopped,
  };
}

describe('createHangDetectionProvider', () => {
  it('is the node-hang provider gated by detect.hang', () => {
    const p = createHangDetectionProvider({ thresholds: T });
    expect(p.name).toBe('node-hang');
    expect(p.controllingOption).toBe('com.bugsee.option.detect.hang');
  });

  it('onStart starts the watchdog and onStop stops it', () => {
    const fw = fakeWatchdog();
    const p = createHangDetectionProvider({
      thresholds: T,
      scheduler: noopScheduler,
      heartbeatIntervalMs: 500,
      createWatchdog: fw.create,
    });
    p.start(fakeClient, () => {});
    expect(fw.started()).toBe(true);
    p.stop();
    expect(fw.stopped()).toBe(true);
  });

  it('submits an Error report "Main thread hang detected" with the AppHang domain + duration', () => {
    const fw = fakeWatchdog();
    const reports: ReportingRequest[] = [];
    const p = createHangDetectionProvider({ thresholds: T, createWatchdog: fw.create });
    p.start(fakeClient, (r) => reports.push(r));
    fw.hang('medium', 6000);
    expect(reports).toHaveLength(1);
    const r = reports[0] as ReportingRequest;
    expect(r.source.type).toBe('error');
    expect(r.source.mechanism).toBe('hang');
    expect(r.report.type).toBe('error');
    expect(r.report.summary).toBe('Main thread hang detected');
    expect(r.report.description).toBe('Event loop blocked for 6000ms (AppHang::Medium)');
    expect(r.report.labels).toEqual(['AppHang::Medium']);
    expect(r.report.signatures).toEqual(['AppHang::Medium']);
  });

  it('maps each hang level to its Android domain', () => {
    const cases: ReadonlyArray<[HangLevel, string]> = [
      ['fair', 'AppHang::Fair'],
      ['medium', 'AppHang::Medium'],
      ['severe', 'AppHang::Severe'],
    ];
    for (const [level, domain] of cases) {
      const fw = fakeWatchdog();
      const reports: ReportingRequest[] = [];
      const p = createHangDetectionProvider({ thresholds: T, createWatchdog: fw.create });
      p.start(fakeClient, (r) => reports.push(r));
      fw.hang(level, 4000);
      expect(reports[0]?.report.labels).toEqual([domain]);
    }
  });

  it('does not report a hang before start() or after stop() (sink detached)', () => {
    const fw = fakeWatchdog();
    const reports: ReportingRequest[] = [];
    const p = createHangDetectionProvider({ thresholds: T, createWatchdog: fw.create });
    fw.hang('fair', 3000); // before start → no sink
    p.start(fakeClient, (r) => reports.push(r));
    p.stop();
    fw.hang('fair', 3000); // after stop → sink detached
    expect(reports).toHaveLength(0);
  });

  describe('with a blocking-stack profile source', () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    // One application frame sampled for the whole window.
    const stalled: CpuProfile = {
      nodes: [
        {
          id: 1,
          callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 },
          children: [2],
        },
        {
          id: 2,
          callFrame: {
            functionName: 'crunch',
            url: 'file:///srv/app.js',
            lineNumber: 9,
            columnNumber: 2,
          },
        },
      ],
      startTime: 0,
      endTime: 5_000_000,
      samples: [2, 2, 2],
      timeDeltas: [1000, 1000, 1000],
    };
    const make = (blockingProfile: () => Promise<CpuProfile | undefined>) => {
      const fw = fakeWatchdog();
      const reports: ReportingRequest[] = [];
      const p = createHangDetectionProvider({
        thresholds: T,
        createWatchdog: fw.create,
        blockingProfile,
      });
      p.start(fakeClient, (r) => reports.push(r));
      return { fw, reports, p };
    };

    it('attaches a crash.json with the blocking frames and the AppHang domain', async () => {
      const { fw, reports } = make(async () => stalled);
      fw.hang('severe', 12_000);
      expect(reports).toHaveLength(0); // the profile is awaited before the report is submitted
      await flush();
      expect(reports).toHaveLength(1);
      const r = reports[0] as ReportingRequest;
      expect(exceptionOf(r)?.domain).toBe('AppHang::Severe');
      expect(exceptionOf(r)?.reason).toBe('Event loop blocked for 12000ms');
      expect(exceptionOf(r)?.frames[0]?.data).toEqual({
        source: '/srv/app.js',
        member: 'crunch',
        line: 10,
        column: 3,
      });
      expect(r.report.summary).toBe('Main thread hang detected');
      expect(r.report.labels).toEqual(['AppHang::Severe']);
      // The backend derives the grouping signature from the frames now; the fixed one would override it.
      expect(r.report.signatures).toEqual([]);
    });

    it('looks at a window as long as the stall that was detected', async () => {
      const window: CpuProfile = {
        ...stalled,
        nodes: [
          ...stalled.nodes,
          {
            id: 3,
            callFrame: {
              functionName: 'older',
              url: 'file:///srv/o.js',
              lineNumber: 0,
              columnNumber: 0,
            },
          },
        ],
        samples: [3, 3, 3, 2],
        timeDeltas: [1000, 1000, 1000, 1000],
      };
      const { fw, reports } = make(async () => window);
      fw.hang('fair', 1); // a 1ms window: only the newest sample
      await flush();
      expect(exceptionOf(reports[0])?.frames[0]?.data?.member).toBe('crunch');
    });

    const failing: Array<[string, () => Promise<CpuProfile | undefined>]> = [
      ['no profile', async () => undefined],
      ['an unusable profile', async () => ({ nodes: [], startTime: 0, endTime: 0 })],
      [
        'a failing source',
        async () => {
          throw new Error('inspector gone');
        },
      ],
    ];
    it.each(
      failing,
    )('falls back to the plain hang report (own signature) on %s', async (_n, source) => {
      const { fw, reports } = make(source);
      fw.hang('medium', 6000);
      await flush();
      expect(reports).toHaveLength(1);
      expect(reports[0]?.report.crash).toBeUndefined();
      expect(reports[0]?.report.signatures).toEqual(['AppHang::Medium']);
    });

    it('a longer stall looks at more of the profile', async () => {
      const older: CpuProfile = {
        ...stalled,
        nodes: [
          ...stalled.nodes,
          {
            id: 3,
            callFrame: {
              functionName: 'older',
              url: 'file:///srv/o.js',
              lineNumber: 0,
              columnNumber: 0,
            },
          },
        ],
        samples: [3, 3, 3, 2],
        timeDeltas: [1000, 1000, 1000, 1000],
      };
      const { fw, reports } = make(async () => older);
      fw.hang('fair', 4);
      await flush();
      expect(exceptionOf(reports[0])?.frames[0]?.data?.member).toBe('older');
    });

    it('keeps escalation reports in order even when an earlier profile is slower', async () => {
      let calls = 0;
      const { fw, reports } = make(async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise((r) => setTimeout(r, 20));
        }
        return stalled;
      });
      fw.hang('fair', 3000);
      fw.hang('medium', 5000);
      await new Promise((r) => setTimeout(r, 60));
      expect(reports.map((r) => r.report.labels?.[0])).toEqual([
        'AppHang::Fair',
        'AppHang::Medium',
      ]);
    });

    it('keeps escalation reports in order', async () => {
      const { fw, reports } = make(async () => stalled);
      fw.hang('fair', 3000);
      fw.hang('medium', 5000);
      fw.hang('severe', 10_000);
      await flush();
      expect(reports.map((r) => r.report.labels?.[0])).toEqual([
        'AppHang::Fair',
        'AppHang::Medium',
        'AppHang::Severe',
      ]);
    });

    it('does not deliver a report whose profile resolves after stop()', async () => {
      const { fw, reports, p } = make(async () => stalled);
      fw.hang('fair', 3000);
      p.stop();
      await flush();
      expect(reports).toHaveLength(0);
    });
  });
});
