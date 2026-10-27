import type { ElectronThermalState } from '@bugsee/trackers/electron';

// The ONE place that decides what a thermal state looks like on the wire (`traces.system` `thermal_state`).
//
// OPEN OWNER QUESTION (bugsee-cocoa#288): the mobile SDKs disagree. iOS writes the int `0` nominal / `1` fair /
// `2` serious / `3` critical; Android writes a string. The spec's CURRENT form for JavaScript is the iOS int, because
// Electron's source on macOS is exactly Apple's `NSProcessInfoThermalState`, so the mapping is lossless. If the mobile
// SDKs converge on Android's strings, change ONLY this table:
//
//   nominal -> 'normal', fair -> 'light', serious -> 'severe', critical -> 'critical'
//
// `unknown` has no wire value: it is OMITTED, never written as a number (omit, never zero).
export const THERMAL_STATE_WIRE: Readonly<
  Record<ElectronThermalState, number | string | undefined>
> = {
  unknown: undefined,
  nominal: 0,
  fair: 1,
  serious: 2,
  critical: 3,
};

/** The wire value of a thermal state, or undefined when it has none (a state this table has no row for included). */
export function thermalStateWire(state: ElectronThermalState): number | string | undefined {
  return Object.hasOwn(THERMAL_STATE_WIRE, state) ? THERMAL_STATE_WIRE[state] : undefined;
}
