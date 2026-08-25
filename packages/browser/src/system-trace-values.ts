// Wire-value mappers for the browser system traces whose vocabulary is Android's, not the web's.
//
// `traces.system` is a cross-platform stream: the viewer renders a producer's value the same way
// whatever SDK produced it, by looking the value up in a fixed table. So a web-tier producer that
// emits the browser API's own shape produces a row the viewer cannot render at all:
//
//   - `orientation` — the viewer does `RecordingOrientationsMap[item.value]` (processOrientation) and
//     keys its trace `states` on "0".."4". The value must be the Android `Orientation` int. The web
//     tier was sending `{type, angle}`, which rendered as `[object Object]`.
//   - `connection` — the viewer does `CONNECTION_STATES[value.type]` (processConnection). The value is
//     an object, as on Android, but `type` must be one of the transport names in that table. The web
//     tier was sending `effectiveType` ('4g', '3g'), which is in no table.
//
// The canonical spec is report-bundle-structure/bundle/traces.md ("orientation → int") and Android's
// TraceOrientation / TraceConnectivity.

/**
 * Android's `com.bugsee.library.contracts.internal.Orientation` enum, which IS the wire format for the
 * `orientation` trace on every platform. Mirrored here rather than imported (different language, and
 * this is a 5-value contract that has not changed); the viewer's `states` map is keyed on these.
 */
export const ANDROID_ORIENTATION = {
  Unknown: 0,
  Portrait: 1,
  PortraitUpsideDown: 2,
  LandscapeLeft: 3,
  LandscapeRight: 4,
} as const;

/**
 * Angle → Android orientation, following Android's own `Orientation.fromDisplayRotation(int)`:
 * ROTATION_0 → Portrait, ROTATION_90 → LandscapeRight, ROTATION_180 → PortraitUpsideDown,
 * ROTATION_270 → LandscapeLeft.
 */
const BY_ANGLE: Record<number, number> = {
  0: ANDROID_ORIENTATION.Portrait,
  90: ANDROID_ORIENTATION.LandscapeRight,
  180: ANDROID_ORIENTATION.PortraitUpsideDown,
  270: ANDROID_ORIENTATION.LandscapeLeft,
};

/**
 * Screen Orientation API type → Android orientation.
 *
 * `landscape-primary` is the position a portrait-natural device reaches by rotating +90°, which is what
 * Android calls LandscapeRight — hence the pairing, which looks inverted until you check
 * Orientation.java's rotation mapping.
 */
const BY_TYPE: Record<string, number> = {
  'portrait-primary': ANDROID_ORIENTATION.Portrait,
  'portrait-secondary': ANDROID_ORIENTATION.PortraitUpsideDown,
  'landscape-primary': ANDROID_ORIENTATION.LandscapeRight,
  'landscape-secondary': ANDROID_ORIENTATION.LandscapeLeft,
};

/**
 * The `orientation` trace value: an Android-enum int, never the browser's `{type, angle}` object.
 *
 * `type` wins where present — it is the spec'd field and it accounts for the device's natural
 * orientation, which is landscape on many tablets and would make a raw angle mean the opposite thing.
 * The angle is the fallback for engines that expose only `window.orientation`. Unrecognised → Unknown,
 * because a wrong orientation is worse than a missing one.
 */
export function orientationToWire(type: string | undefined, angle: number | undefined): number {
  // A type we were given but do not recognise does NOT fall through to the angle. The two cases are
  // different: an ABSENT type means the engine has no Screen Orientation API (legacy WebKit exposing
  // only `window.orientation`), where the angle is the intended source and the devices in question are
  // portrait-natural phones. A type that is present but unrecognised means the API answered something
  // this mapper has not been taught, and reinterpreting its angle would be guessing — the angle is
  // relative to the device's NATURAL orientation, which is landscape on many tablets, so angle 0 there
  // is landscape and would be reported as Portrait.
  if (type !== undefined) {
    return BY_TYPE[type] ?? ANDROID_ORIENTATION.Unknown;
  }
  if (angle !== undefined) {
    return BY_ANGLE[angle] ?? ANDROID_ORIENTATION.Unknown;
  }
  return ANDROID_ORIENTATION.Unknown;
}

/** The subset of NetworkInformation this mapper reads. */
export interface ConnectionLike {
  /** NetworkInformation.type — the transport. Chromium-on-Android in practice; absent elsewhere. */
  type?: string;
  /** NetworkInformation.effectiveType — a SPEED bucket ('4g', '3g'), NOT a transport. */
  effectiveType?: string;
}

/** NetworkInformation.type → the transport names the viewer's CONNECTION_STATES table has. */
const TRANSPORTS: Record<string, string> = {
  wifi: 'wifi',
  cellular: 'cellular',
  ethernet: 'ethernet',
  bluetooth: 'bluetooth',
  wimax: 'wimax',
  none: 'not_reachable',
  // 'mixed' and 'other' are spec values meaning "cannot say"; 'unknown' is explicit.
  mixed: 'unknown',
  other: 'unknown',
  unknown: 'unknown',
};

/**
 * The `connection` trace's `type`, in the vocabulary Android uses and the viewer renders.
 *
 * `navigator.onLine` is checked FIRST and outranks everything: it is the one connectivity fact every
 * browser reports, it is the fact a reader most wants, and a NetworkInformation object can still name
 * a transport while the machine is offline.
 *
 * `effectiveType` is deliberately NOT mapped onto a transport. It is a throughput estimate — a wired
 * desktop reports '4g' — so treating it as one would label ordinary broadband as LTE. It is still
 * reported, as a sibling data key, where the viewer shows it as detail rather than as the identity of
 * the connection.
 */
export function connectionTypeToWire(
  connection: ConnectionLike | undefined,
  onLine: boolean,
): string {
  if (!onLine) {
    return 'not_reachable';
  }
  const type = connection?.type;
  if (type !== undefined) {
    const mapped = TRANSPORTS[type];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return 'unknown';
}
