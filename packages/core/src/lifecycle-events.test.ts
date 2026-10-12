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

describe('createLifecycleEmitter — re-entrancy (L2)', () => {
  it('an event emitted from inside a listener is delivered after that listener returns, in order', () => {
    const emitter = createLifecycleEmitter(() => {});
    const log: string[] = [];
    emitter.set((type) => {
      log.push(`start:${type}`);
      if (type === LifecycleEvents.Launching) {
        emitter.emit(LifecycleEvents.Launched);
        log.push('after-nested-emit');
      }
      log.push(`end:${type}`);
    });
    emitter.emit(LifecycleEvents.Launching);
    expect(log).toEqual([
      `start:${LifecycleEvents.Launching}`,
      'after-nested-emit',
      `end:${LifecycleEvents.Launching}`,
      `start:${LifecycleEvents.Launched}`,
      `end:${LifecycleEvents.Launched}`,
    ]);
  });

  it('keeps delivering queued events after a listener throws', () => {
    const onError = vi.fn();
    const emitter = createLifecycleEmitter(onError);
    const seen: string[] = [];
    emitter.set((type) => {
      seen.push(type);
      if (type === LifecycleEvents.Launching) {
        emitter.emit(LifecycleEvents.Launched);
        throw new Error('first');
      }
    });
    emitter.emit(LifecycleEvents.Launching);
    expect(seen).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a listener cleared mid-queue stops receiving the queued events', () => {
    const emitter = createLifecycleEmitter(() => {});
    const seen: string[] = [];
    emitter.set((type) => {
      seen.push(type);
      emitter.emit(LifecycleEvents.Launched);
      emitter.set(null);
    });
    emitter.emit(LifecycleEvents.Launching);
    expect(seen).toEqual([LifecycleEvents.Launching]);
  });
});

describe('createLifecycleEmitter — shared slot (L1)', () => {
  it('reads and writes the listener through the supplied slot, so two emitters share one listener', () => {
    let held: ((t: string) => void) | null = null;
    const slot = {
      get: () => held,
      set: (next: ((t: string) => void) | null) => {
        held = next;
      },
    };
    const first = createLifecycleEmitter(() => {}, slot);
    const second = createLifecycleEmitter(() => {}, slot);
    const listener = vi.fn();
    first.set(listener);
    second.emit(LifecycleEvents.Launched);
    expect(listener).toHaveBeenCalledWith(LifecycleEvents.Launched, undefined);
    second.set(null);
    first.emit(LifecycleEvents.Launched);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
