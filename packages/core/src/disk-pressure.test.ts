import { describe, expect, it, vi } from 'vitest';
import {
  createDiskPressure,
  DISK_LOW_BYTES,
  DISK_NONE_BYTES,
  DISK_RECOVERY_MARGIN_BYTES,
  type DiskPressureLevel,
  isOutOfSpaceError,
} from './disk-pressure';

const MB = 1_000_000;

describe('thresholds', () => {
  it('are the iOS numbers in decimal MB', () => {
    expect(DISK_LOW_BYTES).toBe(50 * MB);
    expect(DISK_NONE_BYTES).toBe(10 * MB);
    expect(DISK_RECOVERY_MARGIN_BYTES).toBe(10 * MB);
  });
});

describe('createDiskPressure — transitions', () => {
  it('starts normal', () => {
    expect(createDiskPressure().level()).toBe('normal');
  });

  it('goes low strictly below 50 MB and none strictly below 10 MB', () => {
    const p = createDiskPressure();
    p.observe(50 * MB);
    expect(p.level()).toBe('normal');
    p.observe(50 * MB - 1);
    expect(p.level()).toBe('low');
    p.observe(10 * MB);
    expect(p.level()).toBe('low');
    p.observe(10 * MB - 1);
    expect(p.level()).toBe('none');
  });

  it('goes straight from normal to none on a deep reading', () => {
    const p = createDiskPressure();
    p.observe(0);
    expect(p.level()).toBe('none');
  });

  it('leaves low only at +10 MB (60 MB)', () => {
    const p = createDiskPressure();
    p.observe(40 * MB);
    p.observe(59 * MB);
    expect(p.level()).toBe('low');
    p.observe(60 * MB - 1);
    expect(p.level()).toBe('low');
    p.observe(60 * MB);
    expect(p.level()).toBe('normal');
  });

  it('leaves none for low only at 20 MB, and for normal only at 60 MB', () => {
    const p = createDiskPressure();
    p.observe(5 * MB);
    p.observe(20 * MB - 1);
    expect(p.level()).toBe('none');
    p.observe(20 * MB);
    expect(p.level()).toBe('low');
    p.observe(5 * MB);
    expect(p.level()).toBe('none');
    p.observe(60 * MB);
    expect(p.level()).toBe('normal');
  });

  it('worsens from low to none at the bare threshold, with no damping', () => {
    const p = createDiskPressure();
    p.observe(30 * MB);
    p.observe(10 * MB - 1);
    expect(p.level()).toBe('none');
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    '5' as unknown as number,
    undefined as unknown as number,
    null as unknown as number,
  ])('ignores the unusable reading %s (pressure is never fabricated)', (reading) => {
    const p = createDiskPressure();
    p.observe(reading);
    expect(p.level()).toBe('normal');
    p.observe(30 * MB);
    p.observe(reading);
    expect(p.level()).toBe('low');
  });
});

describe('createDiskPressure — subscription', () => {
  it('notifies only on a real transition, with the new level', () => {
    const p = createDiskPressure();
    const seen: DiskPressureLevel[] = [];
    p.onChange((l) => seen.push(l));
    p.observe(100 * MB);
    p.observe(40 * MB);
    p.observe(41 * MB);
    p.observe(5 * MB);
    p.observe(100 * MB);
    expect(seen).toEqual(['low', 'none', 'normal']);
  });

  it('unsubscribes', () => {
    const p = createDiskPressure();
    const listener = vi.fn();
    const off = p.onChange(listener);
    off();
    p.observe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates a throwing listener to onError and still tells the others', () => {
    const onError = vi.fn();
    const p = createDiskPressure({ onError });
    const boom = new Error('boom');
    const later = vi.fn();
    p.onChange(() => {
      throw boom;
    });
    p.onChange(later);
    p.observe(0);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(later).toHaveBeenCalledWith('none');
    expect(p.level()).toBe('none');
  });

  it('does not tell a listener subscribed during dispatch about the change in flight', () => {
    const p = createDiskPressure();
    const late = vi.fn();
    p.onChange(() => {
      p.onChange(late);
    });
    p.observe(0);
    expect(late).not.toHaveBeenCalled();
  });

  it('survives a throwing reporter and a missing one', () => {
    const throwing = createDiskPressure({
      onError: () => {
        throw new Error('reporter');
      },
    });
    throwing.onChange(() => {
      throw new Error('listener');
    });
    expect(() => throwing.observe(0)).not.toThrow();
    const silent = createDiskPressure();
    silent.onChange(() => {
      throw new Error('listener');
    });
    expect(() => silent.observe(0)).not.toThrow();
  });
});

describe('createDiskPressure — write failure', () => {
  it('moves to none on an out-of-space error even when the last reading was healthy', () => {
    const p = createDiskPressure();
    p.observe(500 * MB);
    expect(p.noteWriteError(Object.assign(new Error('full'), { name: 'QuotaExceededError' }))).toBe(
      true,
    );
    expect(p.level()).toBe('none');
  });

  it('ignores an error that is not out-of-space', () => {
    const p = createDiskPressure();
    expect(p.noteWriteError(new Error('EPERM'))).toBe(false);
    expect(p.level()).toBe('normal');
  });

  it('stays none against a reading below the none-leave margin and leaves it at 20 MB', () => {
    const p = createDiskPressure();
    p.noteWriteError({ code: 'ENOSPC' });
    p.observe(19 * MB);
    expect(p.level()).toBe('none');
    p.observe(5 * MB);
    expect(p.level()).toBe('none');
    p.observe(20 * MB);
    expect(p.level()).toBe('low');
  });

  it('a healthy reading after the failure ends it, and later readings apply normally', () => {
    const p = createDiskPressure();
    p.noteWriteError({ code: 'ENOSPC' });
    p.observe(500 * MB);
    expect(p.level()).toBe('normal');
    p.observe(30 * MB);
    expect(p.level()).toBe('low');
  });

  it('moves from low to none', () => {
    const p = createDiskPressure();
    p.observe(30 * MB);
    p.noteWriteError({ code: 'EDQUOT' });
    expect(p.level()).toBe('none');
  });
});

describe('isOutOfSpaceError', () => {
  it.each([
    [{ name: 'QuotaExceededError' }],
    [{ name: 'NS_ERROR_DOM_QUOTA_REACHED' }],
    [{ code: 'ENOSPC' }],
    [{ code: 'EDQUOT' }],
  ])('recognises %j', (error) => {
    expect(isOutOfSpaceError(error)).toBe(true);
  });

  it.each([
    [null],
    [undefined],
    ['ENOSPC'],
    [42],
    [{ code: 'EPERM' }],
    [{ code: 28 }],
    [{ name: 'Error' }],
    [{}],
  ])('rejects %j', (error) => {
    expect(isOutOfSpaceError(error)).toBe(false);
  });

  it('answers false for a hostile error whose getters throw', () => {
    const hostile = {
      get name(): string {
        throw new Error('no');
      },
    };
    expect(isOutOfSpaceError(hostile)).toBe(false);
  });
});
