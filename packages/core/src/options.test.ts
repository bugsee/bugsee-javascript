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

  it('reports only the host-supplied options, by canonical key (no defaults, no unknown names)', () => {
    const r = resolveLaunchOptions(
      { captureNetwork: false, appToken: 'secret', transport: 1 },
      defs,
    );
    expect(r.host).toEqual({ 'com.bugsee.option.capture.network': false });
    expect(resolveLaunchOptions({}, defs).host).toEqual({});
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

  it('maps the mobile-parity options (T6) to their canonical identifiers and defaults', () => {
    const expected: Array<[string, string, unknown]> = [
      ['captureLogsLevel', BugseeOption.CaptureLogsLevel, 'verbose'],
      ['captureBreadcrumbs', BugseeOption.CaptureBreadcrumbs, true],
      ['detectHttpErrors', BugseeOption.DetectHttpErrors, false],
      ['captureNetworkDefaultSanitizer', BugseeOption.CaptureNetworkDefaultSanitizer, true],
      ['reportDefaultCrashPriority', BugseeOption.ReportingDefaultCrashPriority, 'blocker'],
      ['reportDefaultErrorPriority', BugseeOption.ReportingDefaultErrorPriority, 'high'],
    ];
    for (const [friendly, key, def] of expected) {
      expect(byFriendly.get(friendly)?.key).toBe(key);
      expect(byFriendly.get(friendly)?.default).toBe(def);
    }
  });

  it('maps notifyFlushDelay (T7) to the config.notify-flush-delay identifier, default 0 ms', () => {
    expect(byFriendly.get('notifyFlushDelay')?.key).toBe(BugseeOption.NotifyFlushDelay);
    expect(byFriendly.get('notifyFlushDelay')?.default).toBe(0);
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
      [BugseeOption.CaptureLogsLevel]: 'verbose',
      [BugseeOption.CaptureBreadcrumbs]: true,
      [BugseeOption.DetectHttpErrors]: false,
      [BugseeOption.CaptureNetworkDefaultSanitizer]: true,
      [BugseeOption.ReportingDefaultCrashPriority]: 'blocker',
      [BugseeOption.ReportingDefaultErrorPriority]: 'high',
      [BugseeOption.NotifyFlushDelay]: 0,
    });
  });
});

describe('resolveLaunchOptions: undefined, validation and normalization (review O1/O7/O9)', () => {
  const resolve = (values: Record<string, unknown>) => {
    const errors: Error[] = [];
    const r = resolveLaunchOptions(values, COMMON_OPTION_DEFINITIONS, (e) => errors.push(e));
    return { r, errors };
  };

  it('treats an explicit undefined as NOT supplied: the default applies and the host bag omits it', () => {
    const { r, errors } = resolve({
      captureNetworkDefaultSanitizer: undefined,
      detectHttpErrors: undefined,
      maxRecordingTime: undefined,
    });
    expect(r.canonical[BugseeOption.CaptureNetworkDefaultSanitizer]).toBe(true);
    expect(r.canonical[BugseeOption.DetectHttpErrors]).toBe(false);
    expect(r.canonical[BugseeOption.Duration]).toBe(60);
    expect(r.host).toEqual({});
    expect(r.isEnabled(BugseeOption.DetectHttpErrors)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('keeps an explicit boolean false (the only value that turns the default sanitizer off)', () => {
    const { r } = resolve({ captureNetworkDefaultSanitizer: false, detectHttpErrors: true });
    expect(r.canonical[BugseeOption.CaptureNetworkDefaultSanitizer]).toBe(false);
    expect(r.canonical[BugseeOption.DetectHttpErrors]).toBe(true);
    expect(r.host[BugseeOption.CaptureNetworkDefaultSanitizer]).toBe(false);
  });

  it.each([
    ['captureNetworkDefaultSanitizer', BugseeOption.CaptureNetworkDefaultSanitizer, true],
    ['detectHttpErrors', BugseeOption.DetectHttpErrors, false],
    ['captureNetwork', BugseeOption.CaptureNetwork, true],
    ['captureBreadcrumbs', BugseeOption.CaptureBreadcrumbs, true],
    ['detectCrashes', BugseeOption.DetectCrash, true],
  ])('a non-boolean %s reports to onError and falls back to the default', (friendly, key, def) => {
    for (const bad of ['no', 0, null, {}]) {
      const { r, errors } = resolve({ [friendly]: bad });
      expect(r.canonical[key]).toBe(def);
      expect(r.host[key]).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain(friendly);
      expect(errors[0]?.message).toContain('boolean');
    }
  });

  it('writes the NORMALIZED value back (trimmed/lowercased names)', () => {
    const { r, errors } = resolve({
      captureLogsLevel: ' Warning ',
      reportDefaultErrorPriority: 'Critical',
      reportDefaultCrashPriority: 'High',
    });
    expect(r.canonical[BugseeOption.CaptureLogsLevel]).toBe('warning');
    expect(r.host[BugseeOption.CaptureLogsLevel]).toBe('warning');
    expect(r.canonical[BugseeOption.ReportingDefaultErrorPriority]).toBe('critical');
    expect(r.canonical[BugseeOption.ReportingDefaultCrashPriority]).toBe('high');
    expect(errors).toEqual([]);
  });

  it.each([
    [1, 'error'],
    [2, 'warning'],
    [3, 'info'],
    [4, 'debug'],
    [5, 'verbose'],
  ])('accepts the integer log level %i as %s', (n, name) => {
    const { r, errors } = resolve({ captureLogsLevel: n });
    expect(r.canonical[BugseeOption.CaptureLogsLevel]).toBe(name);
    expect(errors).toEqual([]);
  });

  it.each([
    0,
    6,
    2.5,
    'urgent',
    {},
    true,
  ])('an invalid log level %j reports and uses verbose', (bad) => {
    const { r, errors } = resolve({ captureLogsLevel: bad });
    expect(r.canonical[BugseeOption.CaptureLogsLevel]).toBe('verbose');
    expect(r.host[BugseeOption.CaptureLogsLevel]).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('captureLogsLevel');
  });

  it('an invalid priority reports and uses the default', () => {
    const { r, errors } = resolve({ reportDefaultErrorPriority: 'urgent' });
    expect(r.canonical[BugseeOption.ReportingDefaultErrorPriority]).toBe('high');
    expect(errors[0]?.message).toContain('reportDefaultErrorPriority');
  });

  it('works without onError (silent fallback) and survives an onError that throws', () => {
    expect(
      resolveLaunchOptions({ detectHttpErrors: 'x' }, COMMON_OPTION_DEFINITIONS).canonical[
        BugseeOption.DetectHttpErrors
      ],
    ).toBe(false);
    expect(
      resolveLaunchOptions({ detectHttpErrors: 'x' }, COMMON_OPTION_DEFINITIONS, () => {
        throw new Error('boom');
      }).canonical[BugseeOption.DetectHttpErrors],
    ).toBe(false);
  });
});
