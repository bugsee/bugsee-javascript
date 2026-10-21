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
 * Screen Orientation API type → Android orientation.
 *
 * This is EXACT rather than approximate, and pleasingly so: the web's four `type` values line up with
 * `Orientation.fromAngle`'s output one-for-one whatever the device's natural orientation is, because
 * both abstractions already account for it.
 *
 *   type                | portrait-natural | landscape-natural | fromAngle
 *   portrait-primary    | angle 0          | angle 90          | Portrait (1)
 *   landscape-primary   | angle 90         | angle 0           | LandscapeLeft (3)
 *   portrait-secondary  | angle 180        | angle 270         | PortraitUpsideDown (2)
 *   landscape-secondary | angle 270        | angle 180         | LandscapeRight (4)
 *
 * Derived from what our SDKs actually write into the trace, not from the platform docs:
 *   Android — TraceOrientation: `entry.value = orientation.getIntValue()` (the Orientation enum, 0..4),
 *             sourced from BugseeTrackerUI.getScreenOrientation → fromDisplayRotation(w,h,rot) → fromAngle.
 *   iOS     — BGSEventManager.m:511: the raw `(int) UIInterfaceOrientation`, no mapping applied.
 * Both therefore put a 0..4 int on the wire with 3 and 4 as the two landscape positions.
 *
 * The two platforms NAME those ints oppositely — Android's enum is named for the device orientation,
 * UIKit's for the interface orientation, and UIKit aliases each to the other's value. That is why the
 * viewer labels 3 "LandscapeRight" while Android's enum calls 3 LandscapeLeft; it is a naming
 * difference between the platforms, not a defect in either. This table follows Android, because
 * `fromAngle` is the one path traceable end-to-end in our own code from a display rotation — which is
 * what the web's `angle` is — to a trace value.
 */
const BY_TYPE: Record<string, number> = {
  'portrait-primary': ANDROID_ORIENTATION.Portrait,
  'portrait-secondary': ANDROID_ORIENTATION.PortraitUpsideDown,
  'landscape-primary': ANDROID_ORIENTATION.LandscapeLeft,
  'landscape-secondary': ANDROID_ORIENTATION.LandscapeRight,
};

/**
 * The `orientation` trace value: an Android-enum int, never the browser's `{type, angle}` object.
 *
 * Derived from the Screen Orientation `type` only. It accounts for the device's natural orientation (landscape on
 * many tablets), which a raw angle does not. There is deliberately NO angle-only fallback: the producer writes the
 * entry only when the engine supplies BOTH `type` and `angle` (spec: both, or nothing), so such a branch was dead code.
 * A type the mapper does not know maps to Unknown, because a wrong orientation is worse than a missing one.
 */
export function orientationToWire(type: string): number {
  return BY_TYPE[type] ?? ANDROID_ORIENTATION.Unknown;
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

/** The viewer's `charging` table is keyed by the Android/iOS ints (0 unknown, 1 unplugged, 2 charging, 3 full) and
 *  `processCharging` takes an int or `{state}`. A boolean never matched (false is dropped by a falsy guard; true looks up
 *  states["true"]), so the old trace rendered nothing. `source` is omitted: the Battery API cannot say AC/USB/wireless. */
export function chargingToWire(b: { charging: boolean; level: number }): { state: 1 | 2 | 3 } {
  if (!b.charging) return { state: 1 };
  return { state: b.level >= 1 ? 3 : 2 };
}
