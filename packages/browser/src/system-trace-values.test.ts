import { describe, expect, it } from 'vitest';
import {
  ANDROID_ORIENTATION,
  connectionTypeToWire,
  orientationToWire,
} from './system-trace-values';

// These two mappers exist because the browser's own vocabularies are not the wire's. The wire's is
// Android's, and the viewer keys its rendering directly off it:
//   - `orientation` → an INT the viewer looks up in RecordingOrientationsMap / the trace `states` map
//     (recording-system-traces.constant.ts, states "0".."4");
//   - `connection.type` → a STRING the viewer looks up in CONNECTION_STATES (processingHelpers.ts).
// A value outside those sets renders as `[object Object]` or a blank row, which is exactly what the
// web tier was producing before this.

describe('orientationToWire', () => {
  it('maps every Screen Orientation API type onto the Android enum', () => {
    expect(orientationToWire('portrait-primary', 0)).toBe(ANDROID_ORIENTATION.Portrait);
    expect(orientationToWire('portrait-secondary', 180)).toBe(
      ANDROID_ORIENTATION.PortraitUpsideDown,
    );
    // A portrait-natural device rotated +90° is `landscape-primary`, which is the same physical
    // position Android calls LandscapeRight (its ROTATION_90 → LandscapeRight, Orientation.java).
    expect(orientationToWire('landscape-primary', 90)).toBe(ANDROID_ORIENTATION.LandscapeRight);
    expect(orientationToWire('landscape-secondary', 270)).toBe(ANDROID_ORIENTATION.LandscapeLeft);
  });

  it('is an INT, never the {type, angle} object the Screen Orientation API hands out', () => {
    // The actual defect: the sampler forwarded `{type, angle}` verbatim, so the viewer's
    // `RecordingOrientationsMap[item.value]` looked up an object key and found nothing.
    for (const type of [
      'portrait-primary',
      'portrait-secondary',
      'landscape-primary',
      'landscape-secondary',
    ]) {
      expect(typeof orientationToWire(type, 0)).toBe('number');
    }
  });

  it('lands inside the 0-4 range the viewer has states for, for every input', () => {
    const inputs = ['portrait-primary', 'landscape-primary', '', 'nonsense', 'PORTRAIT-PRIMARY'];
    for (const type of inputs) {
      const value = orientationToWire(type, 0);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(4);
    }
  });

  it('reports Unknown (0) for a type it does not recognise, rather than guessing portrait', () => {
    expect(orientationToWire('nonsense', 0)).toBe(ANDROID_ORIENTATION.Unknown);
    expect(orientationToWire('', 90)).toBe(ANDROID_ORIENTATION.Unknown);
  });

  it('falls back to the ANGLE when the type is missing but the angle is not', () => {
    // Older WebKit exposes `window.orientation` (an angle) and no `screen.orientation.type`. An angle
    // alone still identifies the position, so it is worth more than Unknown.
    expect(orientationToWire(undefined, 0)).toBe(ANDROID_ORIENTATION.Portrait);
    expect(orientationToWire(undefined, 90)).toBe(ANDROID_ORIENTATION.LandscapeRight);
    expect(orientationToWire(undefined, 180)).toBe(ANDROID_ORIENTATION.PortraitUpsideDown);
    expect(orientationToWire(undefined, 270)).toBe(ANDROID_ORIENTATION.LandscapeLeft);
    expect(orientationToWire(undefined, 45)).toBe(ANDROID_ORIENTATION.Unknown);
    expect(orientationToWire(undefined, undefined)).toBe(ANDROID_ORIENTATION.Unknown);
  });

  it('prefers the TYPE over the angle when the two disagree', () => {
    // `type` is the spec'd, device-natural-aware field; the angle is relative to the device's natural
    // orientation, which is landscape on many tablets. Where both exist, type is authoritative.
    expect(orientationToWire('portrait-primary', 90)).toBe(ANDROID_ORIENTATION.Portrait);
  });
});

describe('connectionTypeToWire', () => {
  it('passes through the transports the viewer already renders', () => {
    // These names are shared with Android's TraceConnectivity and are CONNECTION_STATES keys.
    expect(connectionTypeToWire({ type: 'wifi' }, true)).toBe('wifi');
    expect(connectionTypeToWire({ type: 'cellular' }, true)).toBe('cellular');
    expect(connectionTypeToWire({ type: 'ethernet' }, true)).toBe('ethernet');
    expect(connectionTypeToWire({ type: 'bluetooth' }, true)).toBe('bluetooth');
    expect(connectionTypeToWire({ type: 'wimax' }, true)).toBe('wimax');
  });

  it('reports offline as `not_reachable`, the name the viewer has an icon for', () => {
    // navigator.onLine is the ONE connectivity fact every browser agrees on, and it is the one a
    // reader most wants. It outranks a stale NetworkInformation reading.
    expect(connectionTypeToWire({ type: 'wifi' }, false)).toBe('not_reachable');
    expect(connectionTypeToWire(undefined, false)).toBe('not_reachable');
    expect(connectionTypeToWire({ type: 'none' }, true)).toBe('not_reachable');
  });

  it('reports `unknown` when the browser exposes no transport — which is most of them', () => {
    // NetworkInformation.type is Chromium-on-Android in practice. `effectiveType` ('4g', '3g') is a
    // SPEED BUCKET, not a transport, so it must never be mapped onto one: a '4g' effectiveType on a
    // desktop wired connection would otherwise be reported as LTE. It rides along as data instead.
    expect(connectionTypeToWire({ effectiveType: '4g' }, true)).toBe('unknown');
    expect(connectionTypeToWire({}, true)).toBe('unknown');
    expect(connectionTypeToWire(undefined, true)).toBe('unknown');
  });

  it('collapses the vague NetworkInformation values onto `unknown`', () => {
    // 'mixed' and 'other' are real values in the spec and mean "we cannot tell you".
    expect(connectionTypeToWire({ type: 'mixed' }, true)).toBe('unknown');
    expect(connectionTypeToWire({ type: 'other' }, true)).toBe('unknown');
    expect(connectionTypeToWire({ type: 'unknown' }, true)).toBe('unknown');
  });

  it('never returns a value the viewer has no state for', () => {
    const RENDERABLE = new Set([
      'wifi',
      'cellular',
      'ethernet',
      'bluetooth',
      'wimax',
      'unknown',
      'not_reachable',
    ]);
    const inputs = [
      undefined,
      {},
      { type: 'wifi' },
      { type: 'nonsense' },
      { type: '' },
      { effectiveType: 'slow-2g' },
    ];
    for (const connection of inputs) {
      for (const online of [true, false]) {
        expect(RENDERABLE.has(connectionTypeToWire(connection, online))).toBe(true);
      }
    }
  });
});
