import { describe, expect, it } from 'vitest';
import { penAngles, tiltToSpherical } from './pen-angles';

const { PI } = Math;

describe('tiltToSpherical (Pointer Events Level 3 conversion)', () => {
  it.each([
    // [tiltX°, tiltY°, altitude, azimuth] — azimuth 0 along +x, increasing clockwise (y points down)
    [0, 0, PI / 2, 0], // perpendicular
    [45, 0, PI / 4, 0], // leaning toward +x
    [0, 45, PI / 4, PI / 2], // toward +y (down the screen)
    [-45, 0, PI / 4, PI], // toward −x
    [0, -45, PI / 4, (3 * PI) / 2], // toward −y
    [30, 30, Math.atan(1 / Math.sqrt(2 * Math.tan(PI / 6) ** 2)), PI / 4],
    [-30, 30, Math.atan(1 / Math.sqrt(2 * Math.tan(PI / 6) ** 2)), (3 * PI) / 4],
    [-30, -30, Math.atan(1 / Math.sqrt(2 * Math.tan(PI / 6) ** 2)), (5 * PI) / 4],
    [30, -30, Math.atan(1 / Math.sqrt(2 * Math.tan(PI / 6) ** 2)), (7 * PI) / 4],
  ])('tilt (%d°, %d°) → altitude %f, azimuth %f', (tiltX, tiltY, altitude, azimuth) => {
    const angles = tiltToSpherical(tiltX, tiltY);
    expect(angles.altitudeAngle).toBeCloseTo(altitude, 12);
    expect(angles.azimuthAngle).toBeCloseTo(azimuth, 12);
  });

  it.each([
    // FLAT on the surface: altitude 0. The spec's boundary rules decide the azimuth.
    [90, 0, 0], // tiltY == 0, tiltX > 0 → 0
    [-90, 0, PI], // tiltY == 0, tiltX < 0 → π
    [0, 90, PI / 2], // tiltX == 0 checked first → from tiltY
    [0, -90, (3 * PI) / 2],
    [90, 30, 0], // neither is 0 but one is ±90: not enough information → 0
    [-20, -90, 0],
  ])('flat pen, tilt (%d°, %d°) → altitude 0, azimuth %f', (tiltX, tiltY, azimuth) => {
    const angles = tiltToSpherical(tiltX, tiltY);
    expect(angles.altitudeAngle).toBe(0);
    expect(angles.azimuthAngle).toBeCloseTo(azimuth, 12);
  });

  it('matches a real engine bit-for-bit (Chromium 151, measured via a CDP pen event)', () => {
    // Chromium derives its Level 3 angles from the same tilt; a pen pressed with tiltX 30 / tiltY -20
    // reported exactly these, so the fallback and the preferred path agree on a real browser.
    expect(tiltToSpherical(30, -20)).toStrictEqual({
      altitudeAngle: 0.9719114296335162,
      azimuthAngle: 5.720701576706406,
    });
  });

  it('agrees with the geometry of the pen axis for arbitrary non-boundary tilts', () => {
    // Independent derivation: the pen axis points along (tan tiltX, tan tiltY, 1). Its elevation above
    // the surface is the altitude, and its direction in the screen plane is the azimuth.
    for (let tiltX = -85; tiltX <= 85; tiltX += 17) {
      for (let tiltY = -85; tiltY <= 85; tiltY += 13) {
        if (tiltX === 0 || tiltY === 0) continue;
        const x = Math.tan((tiltX * PI) / 180);
        const y = Math.tan((tiltY * PI) / 180);
        const azimuth = (Math.atan2(y, x) + 2 * PI) % (2 * PI);
        const angles = tiltToSpherical(tiltX, tiltY);
        expect(angles.altitudeAngle).toBeCloseTo(Math.atan2(1, Math.hypot(x, y)), 12);
        expect(angles.azimuthAngle).toBeCloseTo(azimuth, 12);
      }
    }
  });
});

describe('penAngles', () => {
  it('passes the Level 3 angles straight through when the browser provides them', () => {
    expect(
      penAngles({ altitudeAngle: 0.7, azimuthAngle: 2.5, tiltX: 10, tiltY: -20 }),
    ).toStrictEqual({ altitudeAngle: 0.7, azimuthAngle: 2.5 });
  });

  it('keeps a real perpendicular reading whose azimuth is not the default', () => {
    expect(penAngles({ altitudeAngle: PI / 2, azimuthAngle: 1 })).toStrictEqual({
      altitudeAngle: PI / 2,
      azimuthAngle: 1,
    });
  });

  it('keeps a real 0-azimuth reading whose altitude is not the default', () => {
    expect(penAngles({ altitudeAngle: 0.3, azimuthAngle: 0 })).toStrictEqual({
      altitudeAngle: 0.3,
      azimuthAngle: 0,
    });
  });

  it('falls back to tiltX/tiltY when the Level 3 angles are absent', () => {
    const angles = penAngles({ tiltX: 0, tiltY: 45 });
    expect(Object.keys(angles).sort()).toStrictEqual(['altitudeAngle', 'azimuthAngle']);
    expect(angles.altitudeAngle).toBeCloseTo(PI / 4, 12);
    expect(angles.azimuthAngle).toBeCloseTo(PI / 2, 12);
  });

  it('falls back to tilt when the Level 3 angles are the no-data defaults but tilt is real', () => {
    const angles = penAngles({ altitudeAngle: PI / 2, azimuthAngle: 0, tiltX: -45, tiltY: 0 });
    expect(angles.altitudeAngle).toBeCloseTo(PI / 4, 12);
    expect(angles.azimuthAngle).toBeCloseTo(PI, 12);
  });

  it('falls back to tilt when only ONE Level 3 angle is a number', () => {
    const angles = penAngles({ altitudeAngle: 0.5, tiltX: 45, tiltY: 0 });
    expect(angles.altitudeAngle).toBeCloseTo(PI / 4, 12);
    expect(angles.azimuthAngle).toBe(0);
  });

  // A browser whose hardware reports no angle data MUST send altitude π/2 + azimuth 0 (and tilt 0/0).
  // Written through, they are indistinguishable from a pen held upright, so they are omitted — which
  // renders the same (an upright pen casts no shadow) without claiming a reading the device never made.
  it.each([
    ['no angle or tilt properties at all', {}],
    ['the Level 3 no-data defaults', { altitudeAngle: PI / 2, azimuthAngle: 0 }],
    ['tilt 0/0 (the Level 2 no-data default)', { tiltX: 0, tiltY: 0 }],
    ['both defaults together', { altitudeAngle: PI / 2, azimuthAngle: 0, tiltX: 0, tiltY: 0 }],
    ['only tiltX', { tiltX: 30 }],
    ['non-finite tilt', { tiltX: Number.NaN, tiltY: 10 }],
    ['non-numeric tilt', { tiltX: '30', tiltY: '10' }],
    ['tilt outside [-90, 90]', { tiltX: 91, tiltY: 0 }],
    ['tilt below -90', { tiltX: 0, tiltY: -91 }],
    ['non-finite Level 3 angles', { altitudeAngle: Number.POSITIVE_INFINITY, azimuthAngle: 1 }],
    ['altitude outside [0, π/2]', { altitudeAngle: -0.1, azimuthAngle: 1 }],
    ['altitude above π/2', { altitudeAngle: PI / 2 + 0.01, azimuthAngle: 1 }],
    ['azimuth outside [0, 2π]', { altitudeAngle: 0.5, azimuthAngle: 2 * PI + 0.01 }],
    ['negative azimuth', { altitudeAngle: 0.5, azimuthAngle: -0.01 }],
  ])('omits both fields for %s', (_label, event) => {
    expect(penAngles(event)).toStrictEqual({});
  });

  it('accepts the range boundaries themselves', () => {
    expect(penAngles({ altitudeAngle: 0, azimuthAngle: 2 * PI })).toStrictEqual({
      altitudeAngle: 0,
      azimuthAngle: 2 * PI,
    });
    expect(penAngles({ tiltX: -90, tiltY: 0 })).toStrictEqual({
      altitudeAngle: 0,
      azimuthAngle: PI,
    });
  });
});
