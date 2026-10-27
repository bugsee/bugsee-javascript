import type { ElectronThermalState } from '@bugsee/trackers/electron';
import { describe, expect, it } from 'vitest';
import { THERMAL_STATE_WIRE, thermalStateWire } from './thermal-state-wire';

describe('thermal_state wire table (OPEN OWNER QUESTION: bugsee-cocoa#288, int vs Android strings)', () => {
  it('the table is the iOS int form (the spec value form today), and unknown has no wire value', () => {
    expect(THERMAL_STATE_WIRE).toStrictEqual({
      unknown: undefined,
      nominal: 0,
      fair: 1,
      serious: 2,
      critical: 3,
    });
  });

  it('thermalStateWire reads ONLY the table (so changing the form is a one-place edit)', () => {
    const states: ElectronThermalState[] = ['unknown', 'nominal', 'fair', 'serious', 'critical'];
    expect(states.map(thermalStateWire)).toEqual([undefined, 0, 1, 2, 3]);
  });

  it('a state the table has no row for answers undefined (omit, never guess)', () => {
    expect(thermalStateWire('meltdown' as ElectronThermalState)).toBeUndefined();
  });

  it('does not resolve inherited Object.prototype keys as states', () => {
    expect(thermalStateWire('toString' as ElectronThermalState)).toBeUndefined();
    expect(thermalStateWire('constructor' as ElectronThermalState)).toBeUndefined();
  });
});
