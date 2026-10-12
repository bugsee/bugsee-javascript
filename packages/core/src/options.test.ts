import { BugseeOption } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  BOOLEAN_OR_BAG_OPTION,
  COMMON_OPTION_DEFINITIONS,
  createOptionsContainer,
  FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION,
  FAIL_ON_BOOLEAN_OPTION,
  type OptionDefinition,
  resolveFailOnBoolean,
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
      [BugseeOption.ReportingDefaultBugPriority]: 'high',
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

// R2P-4 / R2P-5. Every boolean launch option, every kind of value. The rule (product decision, round 2):
//   - an option that CAPTURES data and is ON by default is FAIL-CLOSED: anything that is not boolean `true`
//     or `false` turns it OFF and tells `onError` (`0`, `null`, `''` and `'false'` all mean "no" to a human);
//   - an option that PROTECTS (the default sanitizer) keeps its protective default on an invalid value;
//   - a non-privacy option that is ON by default (crash detection) keeps its default on an invalid value;
//   - an option that is OFF by default turns on ONLY for boolean `true`.
// Each invalid value is reported, never silently coerced.
describe('every boolean launch option: undefined / null / 0 / "" / "false" / "true" / 1 / true / false', () => {
  const failClosed = [
    'captureLogs',
    'captureNetwork',
    'captureNetworkBodies',
    'captureSystemTraces',
    'captureSystemEvents',
    'captureBreadcrumbs',
  ] as const;
  const keepDefaultOn = ['detectCrashes', 'captureNetworkDefaultSanitizer'] as const;
  const defaultOff = ['captureNetworkBodyWithoutType', 'detectHttpErrors'] as const;
  const invalids: unknown[] = [null, 0, '', 'false', 'true', 1];

  const run = (name: string, value: unknown) => {
    const errors: Error[] = [];
    const resolved = resolveLaunchOptions({ [name]: value }, COMMON_OPTION_DEFINITIONS, (e) =>
      errors.push(e),
    );
    const def = COMMON_OPTION_DEFINITIONS.find((d) => d.friendly === name) as OptionDefinition;
    return { value: resolved.canonical[def.key], host: resolved.host[def.key], errors, def };
  };

  it('lists every boolean COMMON option (a new one must be classified here)', () => {
    const booleans = COMMON_OPTION_DEFINITIONS.filter((d) => typeof d.default === 'boolean')
      .map((d) => d.friendly)
      .sort();
    expect(booleans).toEqual([...failClosed, ...keepDefaultOn, ...defaultOff].sort());
  });

  for (const name of failClosed) {
    it(`${name} (default ON, data capture): invalid => OFF + onError; true/false honoured`, () => {
      expect(run(name, undefined)).toMatchObject({ value: true, errors: [] });
      for (const invalid of invalids) {
        const r = run(name, invalid);
        expect(r.value, `${name}=${String(invalid)}`).toBe(false);
        expect(r.host, `${name}=${String(invalid)} host`).toBe(false);
        expect(r.errors, `${name}=${String(invalid)}`).toHaveLength(1);
        expect(r.errors[0]?.message).toContain(name);
        expect(r.errors[0]?.message).toContain('using false');
      }
      expect(run(name, true)).toMatchObject({ value: true, errors: [] });
      expect(run(name, false)).toMatchObject({ value: false, errors: [] });
    });
  }

  for (const name of keepDefaultOn) {
    it(`${name} (default ON, protective/non-capture): invalid => stays ON + onError`, () => {
      for (const invalid of invalids) {
        const r = run(name, invalid);
        expect(r.value, `${name}=${String(invalid)}`).toBe(true);
        expect(r.errors, `${name}=${String(invalid)}`).toHaveLength(1);
      }
      expect(run(name, false)).toMatchObject({ value: false, errors: [] });
      expect(run(name, true)).toMatchObject({ value: true, errors: [] });
    });
  }

  for (const name of defaultOff) {
    it(`${name} (default OFF): only boolean true turns it on; invalid => OFF + onError`, () => {
      expect(run(name, undefined)).toMatchObject({ value: false, errors: [] });
      for (const invalid of invalids) {
        const r = run(name, invalid);
        expect(r.value, `${name}=${String(invalid)}`).toBe(false);
        expect(r.errors, `${name}=${String(invalid)}`).toHaveLength(1);
      }
      expect(run(name, true)).toMatchObject({ value: true, errors: [] });
    });
  }

  it('a throwing onError does not break the fail-closed result', () => {
    const r = resolveLaunchOptions({ captureNetworkBodies: 0 }, COMMON_OPTION_DEFINITIONS, () => {
      throw new Error('sink');
    });
    expect(r.canonical[BugseeOption.CaptureNetworkBodies]).toBe(false);
    expect(r.isEnabled(BugseeOption.CaptureNetworkBodies)).toBe(false);
  });
});

describe('notifyFlushDelay validation (R2P-5)', () => {
  const run = (value: unknown) => {
    const errors: Error[] = [];
    const r = resolveLaunchOptions({ notifyFlushDelay: value }, COMMON_OPTION_DEFINITIONS, (e) =>
      errors.push(e),
    );
    return { value: r.canonical[BugseeOption.NotifyFlushDelay], errors };
  };

  it('accepts a finite number >= 0', () => {
    for (const ok of [0, 1, 250, 1.5]) {
      expect(run(ok)).toEqual({ value: ok, errors: [] });
    }
  });

  it('reports a non-number, NaN, Infinity or negative and uses 0', () => {
    for (const bad of ['100', null, Number.NaN, Number.POSITIVE_INFINITY, -1, {}, true]) {
      const r = run(bad);
      expect(r.value, String(bad)).toBe(0);
      expect(r.errors, String(bad)).toHaveLength(1);
      expect(r.errors[0]?.message).toContain('notifyFlushDelay');
    }
  });
});

describe('reportDefaultBugPriority is a COMMON option (R2D-3)', () => {
  it('maps to the canonical identifier, default high, validated like the other priorities', () => {
    const def = COMMON_OPTION_DEFINITIONS.find((d) => d.friendly === 'reportDefaultBugPriority');
    expect(def?.key).toBe(BugseeOption.ReportingDefaultBugPriority);
    expect(def?.default).toBe('high');
    const errors: Error[] = [];
    const r = resolveLaunchOptions(
      { reportDefaultBugPriority: 'urgent' },
      COMMON_OPTION_DEFINITIONS,
      (e) => errors.push(e),
    );
    expect(r.canonical[BugseeOption.ReportingDefaultBugPriority]).toBe('high');
    expect(errors[0]?.message).toContain('reportDefaultBugPriority');
    expect(errors[0]?.message).toContain('verylow');
    expect(
      resolveLaunchOptions({ reportDefaultBugPriority: ' Critical ' }, COMMON_OPTION_DEFINITIONS)
        .canonical[BugseeOption.ReportingDefaultBugPriority],
    ).toBe('critical');
  });
});

// R3V-2 / R3V-3. The three normalisers added in round 3, over every kind of value.
describe('round-3 option normalisers', () => {
  const run = (def: OptionDefinition, value: unknown) => {
    const errors: Error[] = [];
    const r = resolveLaunchOptions({ opt: value }, [def], (e) => errors.push(e));
    return { value: r.canonical[def.key], host: r.host[def.key], errors };
  };
  const bad: unknown[] = [null, 0, '', 'false', 'true', 1, [], 'x', () => 1];

  describe('FAIL_ON_BOOLEAN_OPTION (protective, default off): invalid => ON + onError', () => {
    const def: OptionDefinition = {
      friendly: 'opt',
      key: 'k',
      default: false,
      ...FAIL_ON_BOOLEAN_OPTION,
    };
    it('treats every non-boolean as ON, reported, and records the host value', () => {
      for (const v of bad) {
        const r = run(def, v);
        expect(r.value, String(v)).toBe(true);
        expect(r.host, String(v)).toBe(true);
        expect(r.errors, String(v)).toHaveLength(1);
        expect(r.errors[0]?.message).toContain('using true');
      }
    });
    it('honours booleans and undefined without reporting', () => {
      expect(run(def, true)).toMatchObject({ value: true, errors: [] });
      expect(run(def, false)).toMatchObject({ value: false, errors: [] });
      expect(run(def, undefined)).toMatchObject({ value: false, errors: [] });
    });
  });

  describe('FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION (collects more data, default off)', () => {
    const def: OptionDefinition = {
      friendly: 'opt',
      key: 'k',
      default: false,
      ...FAIL_CLOSED_BOOLEAN_OR_BAG_OPTION,
    };
    it('non-boolean non-object => OFF + onError', () => {
      for (const v of bad) {
        const r = run(def, v);
        expect(r.value, String(v)).toBe(false);
        expect(r.errors, String(v)).toHaveLength(1);
      }
    });
    it('true and an option bag => ON (recorded as true, never the bag), false => OFF, silently', () => {
      expect(run(def, true)).toMatchObject({ value: true, errors: [] });
      expect(run(def, { session: () => 1 })).toMatchObject({ value: true, host: true, errors: [] });
      expect(run(def, {})).toMatchObject({ value: true, errors: [] });
      expect(run(def, false)).toMatchObject({ value: false, errors: [] });
    });
  });

  describe('BOOLEAN_OR_BAG_OPTION (default on, e.g. replay): invalid => default + onError', () => {
    const def: OptionDefinition = {
      friendly: 'opt',
      key: 'k',
      default: true,
      ...BOOLEAN_OR_BAG_OPTION,
    };
    it('invalid => the default (ON), reported', () => {
      for (const v of bad) {
        const r = run(def, v);
        expect(r.value, String(v)).toBe(true);
        expect(r.errors, String(v)).toHaveLength(1);
        expect(r.errors[0]?.message).toContain('using true');
      }
    });
    it('false => OFF, true / a bag => ON, silently', () => {
      expect(run(def, false)).toMatchObject({ value: false, errors: [] });
      expect(run(def, true)).toMatchObject({ value: true, errors: [] });
      expect(run(def, { canvas: true })).toMatchObject({ value: true, errors: [] });
    });
  });

  describe('resolveFailOnBoolean (renderer side of the same rule)', () => {
    it('undefined => fallback; false => false; anything else (true, "true", 1, null, 0) => true', () => {
      expect(resolveFailOnBoolean(undefined, false)).toBe(false);
      expect(resolveFailOnBoolean(undefined, true)).toBe(true);
      expect(resolveFailOnBoolean(false, true)).toBe(false);
      for (const v of [true, 'true', 1, null, 0, '', 'false', {}]) {
        expect(resolveFailOnBoolean(v, false), String(v)).toBe(true);
      }
    });
  });
});
