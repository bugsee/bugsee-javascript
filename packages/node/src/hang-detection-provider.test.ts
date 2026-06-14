import type { Client, ReportingRequest, Scheduler } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import type {
  EventLoopWatchdog,
  EventLoopWatchdogDeps,
  HangLevel,
  HangThresholds,
} from './event-loop-watchdog';
import { createHangDetectionProvider } from './hang-detection-provider';

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
});
