// Property-based (fuzz) tests for the §8.6 worker environment envelope. Every field here comes from a
// probe of the host runtime or from caller-supplied launch options, and the whole object is JSON-serialized
// onto the wire (and keyed on by the backend), so the mapping is exactly the kind of untrusted-input →
// fixed-schema translation properties are good at: the example tests pin one probe, these pin the mapping
// for every probe. Each expectation is derived from the probe/input a SECOND time rather than restated
// from the implementation.
import { detectBrowser, detectOs } from '@bugsee/browser';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildWorkerEnvironment,
  type WorkerEnvironmentInput,
  type WorkerPlatformType,
  type WorkerProbe,
} from './environment';

// Real agents alongside arbitrary strings: the OS/browser mapping is only exercised by UAs that parse,
// while the arbitrary ones pin the "unidentifiable agent" path the real world also produces (bots,
// embedded webviews, reduced agents).
const userAgentArb = () =>
  fc.oneof(
    fc.string(),
    fc.constantFrom(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
    ),
  );

const probeArb = () =>
  fc.record({
    userAgent: userAgentArb(),
    uaDataPlatform: fc.option(
      fc.constantFrom('macOS', 'Windows', 'Linux', 'Android', 'iOS', 'Chrome OS', 'Unknown'),
      { nil: undefined },
    ),
    locale: fc.string(),
    utcOffsetMinutes: fc.integer({ min: -720, max: 840 }),
    deviceMemoryBytes: fc.option(fc.integer({ min: 0, max: 64 * 1024 ** 3 }), { nil: undefined }),
    cpuCount: fc.option(fc.integer({ min: 0, max: 512 }), { nil: undefined }),
  });

const asProbe = (values: {
  userAgent: string;
  uaDataPlatform: string | undefined;
  locale: string;
  utcOffsetMinutes: number;
  deviceMemoryBytes: number | undefined;
  cpuCount: number | undefined;
}): WorkerProbe => ({
  userAgent: () => values.userAgent,
  uaDataPlatform: () => values.uaDataPlatform,
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
  it('puts the OS in platform, the worker kind in runtime, and never the raw agent in either', () => {
    fc.assert(
      fc.property(probeArb(), inputArb(), (values, input) => {
        const env = buildWorkerEnvironment(input as WorkerEnvironmentInput, asProbe(values));
        // Derived a second time from the probe rather than restated from the implementation.
        const os = detectOs(values.userAgent, values.uaDataPlatform);
        expect(env.platform.type).toBe(os.type);
        expect(env.platform.version).toBe(os.version);
        // The worker kind is `runtime`'s job — it is not an operating system.
        expect(env.runtime.type).toBe(input.platformType);
        expect(env.platform).toMatchObject({
          utc_offset: values.utcOffsetMinutes,
          locale: values.locale,
        });
      }),
    );
  });

  it('fills the browser block exactly when the agent identifies one, never half of it', () => {
    fc.assert(
      fc.property(probeArb(), inputArb(), (values, input) => {
        const env = buildWorkerEnvironment(input as WorkerEnvironmentInput, asProbe(values));
        const browser = detectBrowser(values.userAgent);
        expect('browser' in env).toBe(browser.type !== '');
        if (browser.type !== '') {
          expect(env.browser).toEqual({ type: browser.type, version: browser.version });
        }
        expect(env.runtime.version).toBe(browser.version);
      }),
    );
  });

  it('reports memory_total in NEITHER block, whatever the probe says', () => {
    // It used to be reported in both, from navigator.deviceMemory. That is a deliberately coarse
    // bucket — a 64 GB machine reports 32 — and `memory_total` means actual physical RAM on every
    // other Bugsee SDK, so it was a confidently wrong number under an exact label. The reading now
    // ships as the `ram_system_advertised` trace. Asserted for EVERY probe, including ones that do
    // report a deviceMemory, so a re-introduction cannot slip through on the undefined path.
    fc.assert(
      fc.property(probeArb(), inputArb(), (values, input) => {
        const env = buildWorkerEnvironment(input as WorkerEnvironmentInput, asProbe(values));
        expect('memory_total' in (env.platform as Record<string, unknown>)).toBe(false);
        expect('memory_total' in (env.hardware as Record<string, unknown>)).toBe(false);
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
