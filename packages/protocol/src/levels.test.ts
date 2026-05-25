import type { LogLevelName, SeverityName } from '@bugsee/types';
import { describe, expect, it } from 'vitest';
import {
  LogLevel,
  logLevelFromWire,
  logLevelToWire,
  Severity,
  severityFromWire,
  severityToWire,
} from './index';

describe('wire enums', () => {
  it('LogLevel is 1=error .. 5=verbose', () => {
    expect([
      LogLevel.Error,
      LogLevel.Warning,
      LogLevel.Info,
      LogLevel.Debug,
      LogLevel.Verbose,
    ]).toEqual([1, 2, 3, 4, 5]);
  });

  it('Severity is 1=verylow .. 5=blocker', () => {
    expect([
      Severity.VeryLow,
      Severity.Medium,
      Severity.High,
      Severity.Critical,
      Severity.Blocker,
    ]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('logLevelToWire', () => {
  it.each<[LogLevelName, number]>([
    ['error', 1],
    ['warning', 2],
    ['info', 3],
    ['debug', 4],
    ['verbose', 5],
  ])('maps %s -> %d', (name, value) => {
    expect(logLevelToWire(name)).toBe(value);
  });
});

describe('logLevelFromWire', () => {
  it.each<[number, LogLevelName]>([
    [1, 'error'],
    [2, 'warning'],
    [3, 'info'],
    [4, 'debug'],
    [5, 'verbose'],
  ])('maps %d -> %s', (value, name) => {
    expect(logLevelFromWire(value)).toBe(name);
  });

  it('throws RangeError on an out-of-range value', () => {
    expect(() => logLevelFromWire(0)).toThrow(RangeError);
    expect(() => logLevelFromWire(6)).toThrow(/Unknown log level/);
  });
});

describe('severityToWire', () => {
  it.each<[SeverityName, number]>([
    ['verylow', 1],
    ['low', 1], // iOS alias -> verylow
    ['medium', 2],
    ['high', 3],
    ['critical', 4],
    ['blocker', 5],
  ])('maps %s -> %d', (name, value) => {
    expect(severityToWire(name)).toBe(value);
  });
});

describe('severityFromWire', () => {
  it.each<[number, SeverityName]>([
    [1, 'verylow'], // canonical, never "low"
    [2, 'medium'],
    [3, 'high'],
    [4, 'critical'],
    [5, 'blocker'],
  ])('maps %d -> %s', (value, name) => {
    expect(severityFromWire(value)).toBe(name);
  });

  it('throws RangeError on an out-of-range value', () => {
    expect(() => severityFromWire(0)).toThrow(RangeError);
    expect(() => severityFromWire(6)).toThrow(/Unknown severity/);
  });
});

describe('round trips', () => {
  it('log level name -> wire -> name is identity', () => {
    for (const name of ['error', 'warning', 'info', 'debug', 'verbose'] as const) {
      expect(logLevelFromWire(logLevelToWire(name))).toBe(name);
    }
  });

  it('severity round-trips, with "low" normalizing to "verylow"', () => {
    expect(severityFromWire(severityToWire('low'))).toBe('verylow');
    for (const name of ['verylow', 'medium', 'high', 'critical', 'blocker'] as const) {
      expect(severityFromWire(severityToWire(name))).toBe(name);
    }
  });
});
