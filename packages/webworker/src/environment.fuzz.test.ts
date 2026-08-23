// Property-based (fuzz) tests for the §8.6 worker environment envelope. Every field here comes from a
// probe of the host runtime or from caller-supplied launch options, and the whole object is JSON-serialized
// onto the wire (and keyed on by the backend), so the mapping is exactly the kind of untrusted-input →
// fixed-schema translation properties are good at: the example tests pin one probe, these pin the mapping
// for every probe. Each expectation is derived from the probe/input a SECOND time rather than restated
// from the implementation.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildWorkerEnvironment,
  type WorkerEnvironmentInput,
  type WorkerPlatformType,
  type WorkerProbe,
} from './environment';

const probeArb = () =>
  fc.record({
    userAgent: fc.string(),
    locale: fc.string(),
    utcOffsetMinutes: fc.integer({ min: -720, max: 840 }),
    deviceMemoryBytes: fc.option(fc.integer({ min: 0, max: 64 * 1024 ** 3 }), { nil: undefined }),
    cpuCount: fc.option(fc.integer({ min: 0, max: 512 }), { nil: undefined }),
  });

const asProbe = (values: {
  userAgent: string;
  locale: string;
  utcOffsetMinutes: number;
  deviceMemoryBytes: number | undefined;
  cpuCount: number | undefined;
}): WorkerProbe => ({
  userAgent: () => values.userAgent,
  locale: () => values.locale,
  utcOffsetMinutes: () => values.utcOffsetMinutes,
  deviceMemoryBytes: () => values.deviceMemoryBytes,
  cpuCount: () => values.cpuCount,
});

// Deliberately includes '' and '0' for every string field: `??` and `||` differ exactly there, and an app
// whose version string is legitimately '' must not silently be reported as '0.0.0'.
const optionalString = () =>
  fc.option(fc.oneof(fc.string(), fc.constantFrom('', '0', 'unknown')), { nil: undefined });

const inputArb = () =>
  fc.record({
    sdkVersion: fc.string(),
    platformType: fc.constantFrom<WorkerPlatformType>('web-worker', 'service-worker'),
    appId: optionalString(),
    appVersion: optionalString(),
    appBuild: optionalString(),
    sdkBuild: optionalString(),
    debuggable: fc.option(fc.boolean(), { nil: undefined }),
    deviceId: optionalString(),
  });

describe('buildWorkerEnvironment — properties', () => {
  it('mirrors the probe verbatim into the platform block', () => {
    fc.assert(
      fc.property(probeArb(), inputArb(), (values, input) => {
        const env = buildWorkerEnvironment(input as WorkerEnvironmentInput, asProbe(values));
        expect(env.platform.type).toBe(input.platformType);
        expect(env.platform.version).toBe(values.userAgent);
        expect(env.platform).toMatchObject({
          utc_offset: values.utcOffsetMinutes,
          locale: values.locale,
        });
      }),
    );
  });

  it('reports device memory in BOTH blocks with the same value, or in neither', () => {
    fc.assert(
      fc.property(probeArb(), inputArb(), (values, input) => {
        const env = buildWorkerEnvironment(input as WorkerEnvironmentInput, asProbe(values));
        const platform = env.platform as Record<string, unknown>;
        const hardware = env.hardware as Record<string, unknown>;
        const expected = values.deviceMemoryBytes !== undefined;
        expect('memory_total' in platform).toBe(expected);
        expect('memory_total' in hardware).toBe(expected);
        if (expected) {
          // ...and in MEGABYTES, not the probe's raw bytes — restated here independently of the
          // builder's own helper so a change to that helper cannot make this pass vacuously.
          const megabytes = Math.floor((values.deviceMemoryBytes as number) / 1024 / 1024);
          expect(platform.memory_total).toBe(megabytes);
          expect(hardware.memory_total).toBe(megabytes);
        }
      }),
    );
  });

  it('includes cpu_count exactly when the probe exposes one, and never a screen (a worker has none)', () => {
    fc.assert(
      fc.property(probeArb(), inputArb(), (values, input) => {
        const hardware = buildWorkerEnvironment(input as WorkerEnvironmentInput, asProbe(values))
          .hardware as Record<string, unknown>;
        expect('cpu_count' in hardware).toBe(values.cpuCount !== undefined);
        if (values.cpuCount !== undefined) {
          expect(hardware.cpu_count).toBe(values.cpuCount);
        }
        expect('screen_width' in hardware).toBe(false);
        expect('screen_height' in hardware).toBe(false);
        expect('pixel_ratio' in hardware).toBe(false);
      }),
    );
  });

  it('defaults app identity ONLY when the field is absent — never when it is falsy', () => {
    fc.assert(
      fc.property(probeArb(), inputArb(), (values, input) => {
        const app = buildWorkerEnvironment(input as WorkerEnvironmentInput, asProbe(values)).app as
          | Record<string, unknown>
          | undefined;
        // `?? default` must survive '' / '0' / false; `|| default` would rewrite all three.
        expect(app?.package_id).toBe(input.appId === undefined ? 'unknown' : input.appId);
        expect(app?.version).toBe(input.appVersion === undefined ? '0.0.0' : input.appVersion);
        expect(app?.build).toBe(input.appBuild === undefined ? '0' : input.appBuild);
        expect(app?.debuggable).toBe(input.debuggable === undefined ? false : input.debuggable);
      }),
    );
  });

  it('carries the device id or an explicit null, and includes sdk.build / sdk.options only when given', () => {
    fc.assert(
      fc.property(
        probeArb(),
        inputArb(),
        fc.option(fc.dictionary(fc.string(), fc.jsonValue()), { nil: undefined }),
        (values, input, options) => {
          const full = { ...input, ...(options !== undefined ? { options } : {}) };
          const env = buildWorkerEnvironment(full as WorkerEnvironmentInput, asProbe(values));
          expect((env.hardware as { device_id: unknown }).device_id).toBe(
            input.deviceId === undefined ? null : input.deviceId,
          );
          expect('build' in env.sdk).toBe(input.sdkBuild !== undefined);
          expect('options' in env.sdk).toBe(options !== undefined);
          expect(env.sdk.version).toBe(input.sdkVersion);
          expect(env.sdk.type).toBe('javascript');
        },
      ),
    );
  });

  it('is wire-exact: JSON.stringify loses nothing, because no key is ever present holding undefined', () => {
    fc.assert(
      fc.property(probeArb(), inputArb(), (values, input) => {
        const env = buildWorkerEnvironment(input as WorkerEnvironmentInput, asProbe(values));
        // toStrictEqual (unlike toEqual) fails when one side has a key whose value is undefined and the
        // other does not — which is precisely what a conditional spread degraded into an unconditional
        // one would produce. The server sees the JSON, so the JSON must be the whole envelope.
        expect(JSON.parse(JSON.stringify(env))).toStrictEqual(env);
      }),
    );
  });
});
