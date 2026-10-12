import { describe, expect, it, vi } from 'vitest';
import { getCarrierLifecycleSlot } from './carrier';
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

describe('createLifecycleEmitter — delivery state lives with the shared slot (R2L-5)', () => {
  it('an event emitted by ANOTHER emitter from inside the listener is queued, not nested', () => {
    const g = {};
    const a = createLifecycleEmitter(() => {}, getCarrierLifecycleSlot(g));
    const b = createLifecycleEmitter(() => {}, getCarrierLifecycleSlot(g));
    const trace: string[] = [];
    let depth = 0;
    a.set((type) => {
      depth += 1;
      trace.push(`${type}@${depth}`);
      if (type === LifecycleEvents.Stopped) {
        // client A's Stopped listener relaunches: client B's Launching/Launched must wait for this return
        b.emit(LifecycleEvents.Launching);
        b.emit(LifecycleEvents.Launched);
        trace.push('listener-returns');
      }
      depth -= 1;
    });
    a.emit(LifecycleEvents.Stopped);
    expect(trace).toEqual([
      `${LifecycleEvents.Stopped}@1`,
      'listener-returns',
      `${LifecycleEvents.Launching}@1`,
      `${LifecycleEvents.Launched}@1`,
    ]);
  });
});

describe('createLifecycleEmitter — runaway listeners (R2L-15)', () => {
  it('stops delivering and reports when listeners keep causing each other forever', () => {
    const onError = vi.fn();
    const emitter = createLifecycleEmitter(onError);
    let delivered = 0;
    emitter.set((type) => {
      delivered += 1;
      // the Launched listener "stops", the Stopping listener "launches": a synchronous cycle
      if (type === LifecycleEvents.Launched) emitter.emit(LifecycleEvents.Stopping);
      if (type === LifecycleEvents.Stopping) emitter.emit(LifecycleEvents.Launched);
    });
    emitter.emit(LifecycleEvents.Launched);
    expect(delivered).toBeGreaterThan(10);
    expect(delivered).toBeLessThanOrEqual(200);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0]?.[0] as Error).message)).toMatch(/lifecycle/i);
  });

  it('recovers after the cut: the next emit() delivers normally', () => {
    const emitter = createLifecycleEmitter(() => {});
    let loop = true;
    const seen: string[] = [];
    emitter.set((type) => {
      seen.push(type);
      if (loop) {
        // two per delivery, so the cut always leaves stale events behind in the queue
        emitter.emit(LifecycleEvents.Launched);
        emitter.emit(LifecycleEvents.Launched);
      }
    });
    emitter.emit(LifecycleEvents.Launched);
    loop = false;
    seen.length = 0;
    emitter.emit(LifecycleEvents.Stopped);
    expect(seen).toEqual([LifecycleEvents.Stopped]);
  });

  it('a normal burst (many queued events, no cycle) is not cut', () => {
    const onError = vi.fn();
    const emitter = createLifecycleEmitter(onError);
    let delivered = 0;
    emitter.set((type) => {
      delivered += 1;
      if (type === LifecycleEvents.Launching) {
        for (let i = 0; i < 30; i += 1) emitter.emit(LifecycleEvents.BeforeReportAssembled);
      }
    });
    emitter.emit(LifecycleEvents.Launching);
    expect(delivered).toBe(31);
    expect(onError).not.toHaveBeenCalled();
  });
});
