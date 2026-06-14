import { describe, expect, it } from 'vitest';
import { PROFILING_OPTION_DEFINITIONS, ProfilingOption } from './options';

describe('node profiling options', () => {
  it('exposes the canonical com.bugsee.option.profiling.* identifiers', () => {
    expect(ProfilingOption.Enabled).toBe('com.bugsee.option.profiling.enabled');
    expect(ProfilingOption.SamplingInterval).toBe(
      'com.bugsee.option.profiling.sampling-interval-micros',
    );
  });

  it('maps friendly names to canonical keys with opt-in defaults (off; 1ms interval)', () => {
    expect(PROFILING_OPTION_DEFINITIONS).toEqual([
      { friendly: 'profiling', key: ProfilingOption.Enabled, default: false },
      {
        friendly: 'profilingSamplingIntervalMicros',
        key: ProfilingOption.SamplingInterval,
        default: 1000,
      },
    ]);
  });
});
