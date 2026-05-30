import { describe, expect, it, vi } from 'vitest';
import { createFilterStore, runFilter } from './filters';

describe('createFilterStore', () => {
  it('starts with all filters unset and carries the onError sink', () => {
    const onError = vi.fn();
    const store = createFilterStore(onError);
    expect(store).toMatchObject({ network: null, log: null, breadcrumb: null, report: null });
    expect(store.onError).toBe(onError);
  });
});

describe('runFilter', () => {
  const onError = vi.fn();

  it('keeps the value unchanged when the filter is null or undefined', () => {
    expect(runFilter(null, 7, onError)).toBe(7);
    expect(runFilter(undefined, 7, onError)).toBe(7);
  });

  it('returns the filtered (mutated/new) value', () => {
    expect(runFilter((n: number) => n * 2, 5, onError)).toBe(10);
  });

  it('returns null when the filter drops the value', () => {
    expect(runFilter(() => null, 5, onError)).toBeNull();
  });

  it('drops the value and routes to onError once when the filter throws', () => {
    const sink = vi.fn();
    const err = new Error('bad');
    expect(
      runFilter(
        () => {
          throw err;
        },
        5,
        sink,
      ),
    ).toBeNull();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(err);
  });
});
