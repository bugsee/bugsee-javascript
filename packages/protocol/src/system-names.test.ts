import { describe, expect, it } from 'vitest';
import { EVENT_PARAMS, EventName, eventParamProblems, TRACE_SPEC, TraceName } from './system-names';

const traceValues = Object.values(TraceName);
const eventValues = Object.values(EventName);

describe('TraceName registry', () => {
  it('maps every key to its own wire name upper-cased, so a name has exactly one spelling', () => {
    for (const [key, wire] of Object.entries(TraceName)) {
      expect(key).toBe(wire.toUpperCase());
      expect(wire).toMatch(/^[a-z][a-z0-9_]*$/); // snake_case on the wire
    }
  });

  it('has no duplicate wire name', () => {
    expect(new Set(traceValues).size).toBe(traceValues.length);
  });

  it('declares spec metadata for exactly the registered traces', () => {
    expect(Object.keys(TRACE_SPEC).sort()).toEqual([...traceValues].sort());
  });

  it('holds only well-formed metadata: a numeric trace has a unit-bearing type, a structured one never has a unit', () => {
    for (const [name, spec] of Object.entries(TRACE_SPEC)) {
      if (spec.valueType === 'object' || spec.valueType === 'list' || spec.valueType === 'string') {
        expect(spec.unit, name).toBeNull();
      }
      expect(['int', 'float', 'string', 'object', 'list']).toContain(spec.valueType);
    }
  });

  it('pins the spellings consumers (the viewer) look up', () => {
    expect(TraceName.RAM_SYSTEM_FREE).toBe('ram_system_free');
    expect(TraceName.CPU_USAGE_PROCESS).toBe('cpu_usage_process');
    expect(TraceName.DISPLAYS).toBe('displays');
    expect(TRACE_SPEC[TraceName.EVENT_LOOP_UTILIZATION]).toEqual({
      valueType: 'float',
      unit: 'percent',
      held: false,
    });
    expect(TRACE_SPEC[TraceName.DISK_MEM_FREE].unit).toBe('mb');
    expect(TRACE_SPEC[TraceName.CPU_USAGE_USER].unit).toBe('us');
    expect(TRACE_SPEC[TraceName.PROCESS_MEMORY_RSS].unit).toBe('bytes');
    expect(TRACE_SPEC[TraceName.BATTERY].held).toBe(true);
  });
});

describe('EventName registry', () => {
  it('has no duplicate wire name and no name shared with a trace', () => {
    expect(new Set(eventValues).size).toBe(eventValues.length);
    for (const name of eventValues) expect(traceValues as string[]).not.toContain(name);
  });

  it('declares params for exactly the registered events, camelCase, optional keys marked with ?', () => {
    expect(Object.keys(EVENT_PARAMS).sort()).toEqual([...eventValues].sort());
    for (const [name, keys] of Object.entries(EVENT_PARAMS)) {
      for (const key of keys) expect(key, name).toMatch(/^[a-z][A-Za-z]*\??$/);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('keeps the mobile spellings for the names shared with Android and iOS', () => {
    expect(EventName.ORIENTATION_CHANGED).toBe('OrientationChanged');
    expect(EventName.DARK_MODE_CHANGED).toBe('DarkModeChanged');
    expect(EventName.APPLICATION_DID_BECOME_ACTIVE).toBe(
      'UIApplicationDidBecomeActiveNotification',
    );
    expect(EventName.APPLICATION_DID_ENTER_BACKGROUND).toBe(
      'UIApplicationDidEnterBackgroundNotification',
    );
    expect(EVENT_PARAMS[EventName.PROCESS_EXITING]).toEqual(['code?', 'persisted?']);
    expect(EVENT_PARAMS[EventName.GC]).toEqual(['count', 'maxPauseMs', 'pauseMs']);
  });
});

describe('eventParamProblems', () => {
  it('accepts exactly the registered keys, optional ones present or not', () => {
    expect(eventParamProblems(EventName.PROCESS_STARTED, undefined)).toEqual([]);
    expect(eventParamProblems(EventName.PROCESS_STARTED, {})).toEqual([]);
    expect(eventParamProblems(EventName.DARK_MODE_CHANGED, { dark: true })).toEqual([]);
    expect(eventParamProblems(EventName.DISPLAY_MODE_CHANGED, { mode: 'browser' })).toEqual([]);
    expect(
      eventParamProblems(EventName.DISPLAY_MODE_CHANGED, { mode: 'browser', previousMode: 'x' }),
    ).toEqual([]);
    expect(eventParamProblems(EventName.ORIENTATION_CHANGED, undefined)).toEqual([]);
  });

  it('reports a key the registry does not list, naming the event and the key', () => {
    expect(eventParamProblems(EventName.DARK_MODE_CHANGED, { dark: true, light: 1 })).toEqual([
      'DarkModeChanged: unexpected param "light"',
    ]);
    expect(eventParamProblems(EventName.PROCESS_STARTED, { x: 1 })).toEqual([
      'process_started: unexpected param "x"',
    ]);
  });

  it('reports a required key that is missing, with or without any params', () => {
    expect(eventParamProblems(EventName.DARK_MODE_CHANGED, {})).toEqual([
      'DarkModeChanged: missing required param "dark"',
    ]);
    expect(eventParamProblems(EventName.DARK_MODE_CHANGED, undefined)).toEqual([
      'DarkModeChanged: missing required param "dark"',
    ]);
    expect(eventParamProblems(EventName.DISPLAY_MODE_CHANGED, { previousMode: 'x' })).toEqual([
      'display_mode_changed: missing required param "mode"',
    ]);
  });

  it('reports a renamed key as both an unexpected and a missing one', () => {
    expect(eventParamProblems(EventName.GC, { count: 1, pause: 2, maxPauseMs: 3 })).toEqual([
      'gc: unexpected param "pause"',
      'gc: missing required param "pauseMs"',
    ]);
  });

  it('knows the display_metrics_changed keys ("the same keys, plus changed")', () => {
    expect(EVENT_PARAMS[EventName.DISPLAY_METRICS_CHANGED]).toEqual(
      expect.arrayContaining(['id', 'nativeId', 'width', 'height', 'changed']),
    );
    expect(
      eventParamProblems(EventName.DISPLAY_METRICS_CHANGED, {
        id: 0,
        nativeId: 1,
        width: 1,
        height: 1,
        scale: 2,
        changed: [],
      }),
    ).toEqual([]);
  });
});
