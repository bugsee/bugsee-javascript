import { describe, expect, it } from 'vitest';
import { BugseeOption, optionKeyFromWire, optionKeyToWire, optionsToWire } from './index';

describe('optionKeyToWire', () => {
  it('replaces every dot with a colon', () => {
    expect(optionKeyToWire('capture.network.bodies')).toBe('capture:network:bodies');
  });

  it('leaves a dotless key unchanged', () => {
    expect(optionKeyToWire('debug')).toBe('debug');
  });

  it('handles an empty key', () => {
    expect(optionKeyToWire('')).toBe('');
  });
});

describe('optionKeyFromWire', () => {
  it('replaces every colon with a dot', () => {
    expect(optionKeyFromWire('capture:network:bodies')).toBe('capture.network.bodies');
  });

  it('round-trips a dotted key', () => {
    expect(optionKeyFromWire(optionKeyToWire('a.b.c'))).toBe('a.b.c');
  });
});

describe('optionsToWire', () => {
  it('translates all keys to colon form, preserving values', () => {
    expect(optionsToWire({ 'capture.network': true, 'max.data.size': 10 })).toEqual({
      'capture:network': true,
      'max:data:size': 10,
    });
  });

  it('does not mutate the input', () => {
    const input = { 'a.b': 1 };
    optionsToWire(input);
    expect(input).toEqual({ 'a.b': 1 });
  });

  it('keeps a __proto__ key as own data without polluting any prototype', () => {
    const out = optionsToWire(JSON.parse('{"__proto__": {"polluted": true}, "a.b": 1}'));
    expect((out as Record<string, unknown>)['a:b']).toBe(1);
    expect((out as Record<string, unknown>).polluted).toBeUndefined(); // not via out's prototype
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // not via global prototype
  });
});

describe('BugseeOption canonical identifiers', () => {
  // These dotted strings are the cross-SDK, on-the-wire identity — a typo silently breaks server
  // correlation, so the exact values are locked here.
  it('match the com.bugsee.option.* contract values', () => {
    expect(BugseeOption.CaptureLogs).toBe('com.bugsee.option.capture.logs');
    expect(BugseeOption.CaptureNetwork).toBe('com.bugsee.option.capture.network');
    expect(BugseeOption.CaptureNetworkBodySizeLimit).toBe(
      'com.bugsee.option.capture.network.body-size-limit',
    );
    expect(BugseeOption.CaptureNetworkDefaultSanitizer).toBe(
      'com.bugsee.option.capture.network.default-sanitizer',
    );
    expect(BugseeOption.CaptureSystemTraces).toBe('com.bugsee.option.capture.system-traces');
    expect(BugseeOption.CaptureSystemEvents).toBe('com.bugsee.option.capture.system-events');
    expect(BugseeOption.CaptureInteractions).toBe('com.bugsee.option.capture.interactions');
    expect(BugseeOption.CaptureViewHierarchy).toBe('com.bugsee.option.capture.view-hierarchy');
    expect(BugseeOption.DetectCrash).toBe('com.bugsee.option.detect.crash');
    expect(BugseeOption.Duration).toBe('com.bugsee.option.config.duration');
    expect(BugseeOption.MaxDataSize).toBe('com.bugsee.option.config.data-size');
  });

  it('are all namespaced under com.bugsee.option. and unique', () => {
    const keys = Object.values(BugseeOption);
    expect(keys.every((k) => k.startsWith('com.bugsee.option.'))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate identifiers
  });

  it('translate to colon wire form for environment.sdk.options (server treats dots as nesting)', () => {
    expect(optionKeyToWire(BugseeOption.CaptureNetwork)).toBe('com:bugsee:option:capture:network');
  });
});
