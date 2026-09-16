// Stylus orientation for pen input: `altitudeAngle` / `azimuthAngle`, in radians, with iOS's names and
// conventions (`UITouch.altitudeAngle` / `azimuthAngle(in:)`) — which Pointer Events Level 3 shares, so a
// browser's own values pass straight through:
//   altitudeAngle  0 = flat on the surface … π/2 = perpendicular
//   azimuthAngle   direction in the screen plane; 0 = along +x, increasing clockwise (y points down)
// The viewer draws the pen's "shadow" from them: azimuth is its direction, altitude its length.

const HALF_PI = Math.PI / 2;
const TWO_PI = 2 * Math.PI;

export interface PenAngles {
  altitudeAngle: number;
  azimuthAngle: number;
}

/** The pointer-event surface this reads — every member optional, since browsers differ. */
export interface PenOrientationLike {
  altitudeAngle?: unknown;
  azimuthAngle?: unknown;
  tiltX?: unknown;
  tiltY?: unknown;
}

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/**
 * `tiltX`/`tiltY` (degrees, −90..90) → altitude/azimuth (radians). A transcription of the Pointer Events
 * Level 3 `tilt2spherical` example, boundary cases included: on a ±90° tilt the pen lies flat, and when
 * the other tilt is non-zero there is not enough information for an azimuth, so the spec answers 0.
 */
export function tiltToSpherical(tiltX: number, tiltY: number): PenAngles {
  const tiltXrad = (tiltX * Math.PI) / 180;
  const tiltYrad = (tiltY * Math.PI) / 180;
  const flat = Math.abs(tiltX) === 90 || Math.abs(tiltY) === 90;

  let azimuthAngle = 0;
  if (tiltX === 0) {
    if (tiltY > 0) azimuthAngle = HALF_PI;
    else if (tiltY < 0) azimuthAngle = 3 * HALF_PI;
  } else if (tiltY === 0) {
    if (tiltX < 0) azimuthAngle = Math.PI;
  } else if (!flat) {
    azimuthAngle = Math.atan2(Math.tan(tiltYrad), Math.tan(tiltXrad));
    if (azimuthAngle < 0) azimuthAngle += TWO_PI;
  }

  let altitudeAngle: number;
  if (flat) altitudeAngle = 0;
  else if (tiltX === 0) altitudeAngle = HALF_PI - Math.abs(tiltYrad);
  else if (tiltY === 0) altitudeAngle = HALF_PI - Math.abs(tiltXrad);
  else altitudeAngle = Math.atan(1 / Math.sqrt(Math.tan(tiltXrad) ** 2 + Math.tan(tiltYrad) ** 2));

  return { altitudeAngle, azimuthAngle };
}

/**
 * The stylus angles for a pen pointer event, or `{}` when the device reported none.
 *
 * Level 3 angles are preferred; `tiltX`/`tiltY` (far more widely supported) are the fallback. Hardware
 * with no tilt sensing is REQUIRED by the spec to report the defaults — altitude π/2 + azimuth 0, tilt
 * 0/0 — and those are omitted rather than written: a viewer cannot tell them from a pen genuinely held
 * upright and pointing right. Omitting them loses nothing visible, because an upright pen casts no
 * shadow either. Out-of-range or non-numeric values are treated as unavailable.
 */
export function penAngles(event: PenOrientationLike): Partial<PenAngles> {
  const { altitudeAngle, azimuthAngle, tiltX, tiltY } = event;
  if (
    inRange(altitudeAngle, 0, HALF_PI) &&
    inRange(azimuthAngle, 0, TWO_PI) &&
    !(altitudeAngle === HALF_PI && azimuthAngle === 0)
  ) {
    return { altitudeAngle, azimuthAngle };
  }
  if (inRange(tiltX, -90, 90) && inRange(tiltY, -90, 90) && !(tiltX === 0 && tiltY === 0)) {
    return tiltToSpherical(tiltX, tiltY);
  }
  return {};
}
