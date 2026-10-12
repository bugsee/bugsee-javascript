import { LogLevel } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { isLogLevelEnabled, parseLogLevelName } from './log-level';

describe('parseLogLevelName', () => {
  it.each(['error', 'warning', 'info', 'debug', 'verbose'])('accepts %s', (name) => {
    expect(parseLogLevelName(name)).toBe(name);
  });

  it('forgives case and surrounding space', () => {
    expect(parseLogLevelName('  WARNING ')).toBe('warning');
  });

  it.each(['warn', 'trace', '', 3, undefined, null, {}])('rejects %j', (value) => {
    expect(parseLogLevelName(value)).toBeUndefined();
  });
});

describe('isLogLevelEnabled', () => {
  it('admits a level at or above (more severe than) the threshold', () => {
    expect(isLogLevelEnabled('error', 'warning')).toBe(true);
    expect(isLogLevelEnabled('warning', 'warning')).toBe(true);
  });

  it('refuses a level below the threshold', () => {
    expect(isLogLevelEnabled('info', 'warning')).toBe(false);
    expect(isLogLevelEnabled('verbose', 'error')).toBe(false);
  });

  it('admits everything at the verbose threshold', () => {
    for (const level of ['error', 'warning', 'info', 'debug', 'verbose'] as const) {
      expect(isLogLevelEnabled(level, 'verbose')).toBe(true);
    }
  });

  it('accepts the numeric wire level too', () => {
    expect(isLogLevelEnabled(LogLevel.Debug, 'info')).toBe(false);
    expect(isLogLevelEnabled(LogLevel.Info, 'info')).toBe(true);
  });
});
