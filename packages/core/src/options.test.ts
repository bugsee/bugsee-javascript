import { BugseeOption } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  COMMON_OPTION_DEFINITIONS,
  createOptionsContainer,
  type OptionDefinition,
  resolveLaunchOptions,
} from './options';

describe('createOptionsContainer', () => {
  it('get returns the configured value when the key is present', () => {
    const c = createOptionsContainer({ captureNetworkBodySizeLimit: 4096 });
    expect(c.get('captureNetworkBodySizeLimit', 20480)).toBe(4096);
  });

  it('get returns the fallback when the key is absent', () => {
    const c = createOptionsContainer({ a: 1 });
    expect(c.get('missing', 'default')).toBe('default');
  });

  it('get returns a stored value even when it is falsy (0 / false / "")', () => {
    const c = createOptionsContainer({ flag: false, count: 0, label: '' });
    expect(c.get('flag', true)).toBe(false);
    expect(c.get('count', 99)).toBe(0);
    expect(c.get('label', 'x')).toBe('');
  });

  it('get returns a present-but-undefined value rather than the fallback', () => {
    const c = createOptionsContainer({ maybe: undefined });
    expect(c.get('maybe', 'fallback')).toBeUndefined();
  });

  it('has reports presence (true for set keys including undefined, false otherwise)', () => {
    const c = createOptionsContainer({ set: 1, undef: undefined });
    expect(c.has('set')).toBe(true);
    expect(c.has('undef')).toBe(true);
    expect(c.has('missing')).toBe(false);
  });

  it('defaults to an empty bag (everything falls back, nothing present)', () => {
    const c = createOptionsContainer();
    expect(c.has('anything')).toBe(false);
    expect(c.get('anything', 42)).toBe(42);
  });

  it('treats only own keys as present (inherited prototype members are not options)', () => {
    const c = createOptionsContainer({});
    expect(c.has('toString')).toBe(false);
    expect(c.get('toString', 'fallback')).toBe('fallback');
  });
});

describe('resolveLaunchOptions', () => {
  const defs: readonly OptionDefinition[] = [
    { friendly: 'captureNetwork', key: 'com.bugsee.option.capture.network', default: true },
    { friendly: 'maxRecordingTime', key: 'com.bugsee.option.config.duration', default: 60 },
  ];

  it('maps friendly names to canonical identifiers, applying defaults for omitted ones', () => {
    const r = resolveLaunchOptions({ captureNetwork: false }, defs);
    expect(r.canonical).toEqual({
      'com.bugsee.option.capture.network': false, // user value
      'com.bugsee.option.config.duration': 60, // default
    });
  });

  it('applies all defaults for an empty bag', () => {
    expect(resolveLaunchOptions({}, defs).canonical).toEqual({
      'com.bugsee.option.capture.network': true,
      'com.bugsee.option.config.duration': 60,
    });
  });

  it('exposes values through the OptionsContainer keyed by canonical identifier', () => {
    const r = resolveLaunchOptions({ maxRecordingTime: 120 }, defs);
    expect(r.options.get('com.bugsee.option.config.duration', 0)).toBe(120);
    expect(r.options.has('com.bugsee.option.capture.network')).toBe(true);
  });

  it('gates a boolean option: enabled unless explicitly false; unknown keys default enabled', () => {
    const r = resolveLaunchOptions({ captureNetwork: false }, defs);
    expect(r.isEnabled('com.bugsee.option.capture.network')).toBe(false); // explicit false
    expect(r.isEnabled('com.bugsee.option.config.duration')).toBe(true); // a non-false value
    expect(r.isEnabled('com.bugsee.option.detect.crash')).toBe(true); // not in defs → enabled
  });

  it('ignores friendly names that are not defined (only declared options resolve)', () => {
    const r = resolveLaunchOptions({ captureNetwork: false, bogus: 1 }, defs);
    expect(r.canonical).not.toHaveProperty('bogus');
    expect(Object.keys(r.canonical).sort()).toEqual([
      'com.bugsee.option.capture.network',
      'com.bugsee.option.config.duration',
    ]);
  });
});

describe('COMMON_OPTION_DEFINITIONS', () => {
  const byFriendly = new Map(COMMON_OPTION_DEFINITIONS.map((d) => [d.friendly, d]));

  it('maps each common friendly name to its canonical com.bugsee.option.* identifier', () => {
    expect(byFriendly.get('captureLogs')?.key).toBe(BugseeOption.CaptureLogs);
    expect(byFriendly.get('captureNetwork')?.key).toBe(BugseeOption.CaptureNetwork);
    expect(byFriendly.get('captureNetworkBodies')?.key).toBe(BugseeOption.CaptureNetworkBodies);
    expect(byFriendly.get('maxNetworkBodySize')?.key).toBe(
      BugseeOption.CaptureNetworkBodySizeLimit,
    );
    expect(byFriendly.get('captureNetworkBodyWithoutType')?.key).toBe(
      BugseeOption.CaptureNetworkBodyWithoutType,
    );
    expect(byFriendly.get('captureSystemTraces')?.key).toBe(BugseeOption.CaptureSystemTraces);
    expect(byFriendly.get('captureSystemEvents')?.key).toBe(BugseeOption.CaptureSystemEvents);
    expect(byFriendly.get('detectCrashes')?.key).toBe(BugseeOption.DetectCrash);
    expect(byFriendly.get('maxRecordingTime')?.key).toBe(BugseeOption.Duration);
  });

  it('defaults capture/detect toggles on and the recording duration to 60s', () => {
    expect(byFriendly.get('captureLogs')?.default).toBe(true);
    expect(byFriendly.get('detectCrashes')?.default).toBe(true);
    expect(byFriendly.get('maxRecordingTime')?.default).toBe(60);
  });

  it('defaults network bodies on, the body size limit to 20480 bytes, and without-type off', () => {
    expect(byFriendly.get('captureNetworkBodies')?.default).toBe(true);
    expect(byFriendly.get('maxNetworkBodySize')?.default).toBe(20480);
    expect(byFriendly.get('captureNetworkBodyWithoutType')?.default).toBe(false);
  });

  it('resolves to all canonical identifiers with defaults when launched with no options', () => {
    const { canonical } = resolveLaunchOptions({}, COMMON_OPTION_DEFINITIONS);
    expect(canonical).toEqual({
      [BugseeOption.CaptureLogs]: true,
      [BugseeOption.CaptureNetwork]: true,
      [BugseeOption.CaptureNetworkBodies]: true,
      [BugseeOption.CaptureNetworkBodySizeLimit]: 20480,
      [BugseeOption.CaptureNetworkBodyWithoutType]: false,
      [BugseeOption.CaptureSystemTraces]: true,
      [BugseeOption.CaptureSystemEvents]: true,
      [BugseeOption.DetectCrash]: true,
      [BugseeOption.Duration]: 60,
    });
  });
});
