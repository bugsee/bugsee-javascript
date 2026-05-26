import type { Mechanism } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from './contracts';
import { createDetectionCoordinator } from './detection-coordinator';
import { DetectionProviderBase } from './detection-provider-base';
import type { ReportingRequest } from './reporting';

const client = { tag: 'client' } as unknown as Client;

// A concrete detector exposing the protected seams for testing + a detect() that routes a request.
class TestDetector extends DetectionProviderBase {
  readonly name = 'test';
  readonly controllingOption = 'detectTest';
  startedWith: Client | null = null;
  stopped = 0;

  protected onStart(c: Client): void {
    this.startedWith = c;
  }
  protected override onStop(): void {
    this.stopped += 1;
  }

  detectCrash(summary?: string, mechanism?: Mechanism): void {
    this.handleReportingRequest(
      this.createCrashReport({
        ...(summary === undefined ? {} : { summary }),
        ...(mechanism === undefined ? {} : { mechanism }),
      }),
    );
  }
  detectError(): void {
    this.handleReportingRequest(this.createErrorReport());
  }
}

describe('DetectionProviderBase', () => {
  it('calls onStart with the client on start', () => {
    const d = new TestDetector();
    d.start(client, () => {});
    expect(d.startedWith).toBe(client);
  });

  it('routes a handled request to the report sink wired at start', () => {
    const d = new TestDetector();
    const report = vi.fn();
    d.start(client, report);
    d.detectCrash('boom');
    expect(report).toHaveBeenCalledTimes(1);
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.source.type).toBe('crash');
    expect(request.source.mechanism).toBe('uncaught'); // crash helper default
    expect(request.report.summary).toBe('boom');
  });

  it('createErrorReport produces an error-sourced request with the programmatic mechanism', () => {
    const d = new TestDetector();
    const report = vi.fn();
    d.start(client, report);
    d.detectError();
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.source.type).toBe('error');
    expect(request.source.mechanism).toBe('programmatic'); // error helper default
  });

  it('lets a detector override the crash mechanism', () => {
    const d = new TestDetector();
    const report = vi.fn();
    d.start(client, report);
    d.detectCrash('rej', 'unhandledrejection');
    expect((report.mock.calls[0]?.[0] as ReportingRequest).source.mechanism).toBe(
      'unhandledrejection',
    );
  });

  it('handleReportingRequest is a no-op before start', () => {
    const d = new TestDetector();
    expect(() => d.detectCrash()).not.toThrow();
  });

  it('detaches the sink on stop (subsequent requests are not routed) and calls onStop', () => {
    const d = new TestDetector();
    const report = vi.fn();
    d.start(client, report);
    d.stop();
    d.detectCrash();
    expect(report).not.toHaveBeenCalled();
    expect(d.stopped).toBe(1);
  });

  it('exposes name and controllingOption to satisfy the DetectionProvider contract', () => {
    const d = new TestDetector();
    expect(d.name).toBe('test');
    expect(d.controllingOption).toBe('detectTest');
  });

  // Integration: the base provider works through the real detection coordinator (cross-module).
  it('routes through the detection coordinator to its onReport sink', () => {
    const coordinator = createDetectionCoordinator();
    const detector = new TestDetector();
    const onReport = vi.fn();
    coordinator.addProvider(detector);
    coordinator.start(client, (opt) => opt === 'detectTest', onReport);
    detector.detectCrash('via-coordinator');
    expect(onReport).toHaveBeenCalledTimes(1);
    expect((onReport.mock.calls[0]?.[0] as ReportingRequest).report.summary).toBe(
      'via-coordinator',
    );
  });

  it('a coordinator-disabled provider is never started, so its requests are not routed', () => {
    const coordinator = createDetectionCoordinator();
    const detector = new TestDetector();
    const onReport = vi.fn();
    coordinator.addProvider(detector);
    coordinator.start(client, () => false, onReport); // detectTest disabled
    detector.detectCrash();
    expect(onReport).not.toHaveBeenCalled();
  });

  it('uses the base default onStop when a subclass does not override it', () => {
    // No onStop override here — exercises the base no-op default.
    class MinimalDetector extends DetectionProviderBase {
      readonly name = 'minimal';
      protected onStart(): void {}
    }
    const d = new MinimalDetector();
    d.start(client, () => {});
    expect(() => d.stop()).not.toThrow();
  });
});
