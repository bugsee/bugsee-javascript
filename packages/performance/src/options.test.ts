import { resolveLaunchOptions } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { PERFORMANCE_OPTION_DEFINITIONS, PerformanceOption } from './options';

describe('PerformanceOption', () => {
  it('declares the canonical com.bugsee.option.performance.* identifiers', () => {
    expect(PerformanceOption.Monitoring).toBe('com.bugsee.option.performance.monitoring');
    expect(PerformanceOption.SampleRate).toBe('com.bugsee.option.performance.sample-rate');
    expect(PerformanceOption.UploadMode).toBe('com.bugsee.option.performance.upload-mode');
    expect(PerformanceOption.FlushIntervalMs).toBe(
      'com.bugsee.option.performance.flush-interval-ms',
    );
  });

  it('are all namespaced under com.bugsee.option.performance. and unique', () => {
    const keys = Object.values(PerformanceOption);
    expect(keys.every((k) => k.startsWith('com.bugsee.option.performance.'))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('PERFORMANCE_OPTION_DEFINITIONS', () => {
  it('maps each friendly name to its canonical key with the on-by-default defaults', () => {
    const byName = Object.fromEntries(PERFORMANCE_OPTION_DEFINITIONS.map((d) => [d.friendly, d]));
    expect(Object.keys(byName).sort()).toEqual([
      'performanceFlushIntervalMs',
      'performanceMonitoring',
      'performanceSampleRate',
      'performanceUploadMode',
      'propagateTrace',
      'traceInteractions',
      'traceNavigations',
    ]);
    expect(byName.performanceMonitoring).toMatchObject({
      key: PerformanceOption.Monitoring,
      default: true,
      invalid: false, // fail-closed: data capture that is on by default
    });
    expect(byName.performanceSampleRate).toEqual({
      friendly: 'performanceSampleRate',
      key: PerformanceOption.SampleRate,
      default: 1,
    });
    expect(byName.performanceUploadMode).toEqual({
      friendly: 'performanceUploadMode',
      key: PerformanceOption.UploadMode,
      default: 'batched',
    });
    expect(byName.performanceFlushIntervalMs).toEqual({
      friendly: 'performanceFlushIntervalMs',
      key: PerformanceOption.FlushIntervalMs,
      default: 30000,
    });
    expect(byName.traceNavigations).toMatchObject({
      key: PerformanceOption.TraceNavigations,
      default: true,
      invalid: false,
    });
    expect(byName.traceInteractions).toMatchObject({
      key: PerformanceOption.TraceInteractions,
      default: true,
      invalid: false,
    });
    expect(byName.propagateTrace).toMatchObject({
      key: PerformanceOption.PropagateTrace,
      default: false,
    });
    expect('invalid' in (byName.propagateTrace as object)).toBe(false); // an invalid value keeps the default OFF
  });

  it('resolves a friendly bag through the core resolver (defaults applied, overrides honoured)', () => {
    const resolved = resolveLaunchOptions(
      { performanceMonitoring: false, performanceSampleRate: 0.25 },
      PERFORMANCE_OPTION_DEFINITIONS,
    );
    expect(resolved.options.get(PerformanceOption.Monitoring, true)).toBe(false);
    expect(resolved.options.get(PerformanceOption.SampleRate, 1)).toBe(0.25);
    expect(resolved.options.get(PerformanceOption.UploadMode, 'realtime')).toBe('batched'); // default
    expect(resolved.options.get(PerformanceOption.FlushIntervalMs, 0)).toBe(30000); // default
  });
});
