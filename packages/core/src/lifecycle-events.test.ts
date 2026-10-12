import { describe, expect, it, vi } from 'vitest';
import { createLifecycleEmitter, LifecycleEvents } from './lifecycle-events';

describe('LifecycleEvents', () => {
  it('uses the Android wire names, prefixed com.bugsee.lifecycle.', () => {
    expect(LifecycleEvents).toEqual({
      Launching: 'com.bugsee.lifecycle.Launching',
      Launched: 'com.bugsee.lifecycle.Launched',
      Stopping: 'com.bugsee.lifecycle.Stopping',
      Stopped: 'com.bugsee.lifecycle.Stopped',
      BlackoutStarted: 'com.bugsee.lifecycle.BlackoutStarted',
      BlackoutEnded: 'com.bugsee.lifecycle.BlackoutEnded',
      RelaunchedAfterCrash: 'com.bugsee.lifecycle.RelaunchedAfterCrash',
      BeforeReportShown: 'com.bugsee.lifecycle.BeforeReportShown',
      AfterReportShown: 'com.bugsee.lifecycle.AfterReportShown',
      BeforeReportUploaded: 'com.bugsee.lifecycle.BeforeReportUploaded',
      AfterReportUploaded: 'com.bugsee.lifecycle.AfterReportUploaded',
      ReportUploadFailed: 'com.bugsee.lifecycle.ReportUploadFailed',
      ReportUploadFailedWithFutureRetry: 'com.bugsee.lifecycle.ReportUploadFailedWithFutureRetry',
      BeforeReportAssembled: 'com.bugsee.lifecycle.BeforeReportAssembled',
      AfterReportAssembled: 'com.bugsee.lifecycle.AfterReportAssembled',
      ReportAssemblyFailed: 'com.bugsee.lifecycle.ReportAssemblyFailed',
    });
  });
});

describe('createLifecycleEmitter', () => {
  it('delivers type and data to the listener', () => {
    const emitter = createLifecycleEmitter(() => {});
    const listener = vi.fn();
    emitter.set(listener);
    emitter.emit(LifecycleEvents.Launched, { a: 1 });
    expect(listener).toHaveBeenCalledWith(LifecycleEvents.Launched, { a: 1 });
  });

  it('delivers falsy and primitive data unchanged', () => {
    const emitter = createLifecycleEmitter(() => {});
    const listener = vi.fn();
    emitter.set(listener);
    emitter.emit(LifecycleEvents.Launched, 1);
    emitter.emit(LifecycleEvents.Launched, 0);
    expect(listener.mock.calls).toEqual([
      [LifecycleEvents.Launched, 1],
      [LifecycleEvents.Launched, 0],
    ]);
  });

  it('passes undefined data when none is given', () => {
    const emitter = createLifecycleEmitter(() => {});
    const listener = vi.fn();
    emitter.set(listener);
    emitter.emit(LifecycleEvents.Stopped);
    expect(listener).toHaveBeenCalledWith(LifecycleEvents.Stopped, undefined);
  });

  it('is a no-op with no listener, and null clears a previous one', () => {
    const onError = vi.fn();
    const emitter = createLifecycleEmitter(onError);
    emitter.emit(LifecycleEvents.Launched);
    const listener = vi.fn();
    emitter.set(listener);
    emitter.set(null);
    emitter.emit(LifecycleEvents.Launched);
    expect(listener).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('replaces the previous listener', () => {
    const emitter = createLifecycleEmitter(() => {});
    const first = vi.fn();
    const second = vi.fn();
    emitter.set(first);
    emitter.set(second);
    emitter.emit(LifecycleEvents.Launched);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('routes a throwing listener to onError and never throws', () => {
    const onError = vi.fn();
    const emitter = createLifecycleEmitter(onError);
    const boom = new Error('boom');
    emitter.set(() => {
      throw boom;
    });
    expect(() => emitter.emit(LifecycleEvents.Launched)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('survives a throwing onError too', () => {
    const emitter = createLifecycleEmitter(() => {
      throw new Error('sink');
    });
    emitter.set(() => {
      throw new Error('listener');
    });
    expect(() => emitter.emit(LifecycleEvents.Launched)).not.toThrow();
  });
});
