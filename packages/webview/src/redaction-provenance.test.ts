import type { FilterStore } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createRedactionProvenance } from './redaction-provenance';

// A minimal FilterStore with only the keys a test toggles.
const store = (over: Partial<FilterStore> = {}): FilterStore => ({
  network: null,
  log: null,
  breadcrumb: null,
  span: null,
  report: null,
  onError: () => {},
  ...over,
});

describe('createRedactionProvenance', () => {
  it('forEntry: true only for the entry type whose filter is set (log)', () => {
    const p = createRedactionProvenance(() => store({ log: (e) => e }));
    expect(p.forEntry('log')).toBe(true);
    expect(p.forEntry('network')).toBe(false);
    expect(p.forEntry('breadcrumbs')).toBe(false);
    // No JS filter applies to system streams → always native-redacted (red:false).
    expect(p.forEntry('traces.system')).toBe(false);
    expect(p.forEntry('events.user')).toBe(false);
    expect(p.forEntry('crash')).toBe(false); // crash is report-driven, not a per-type capture filter
  });

  it('forEntry maps network → network filter and breadcrumbs → breadcrumb filter', () => {
    expect(createRedactionProvenance(() => store({ network: (e) => e })).forEntry('network')).toBe(
      true,
    );
    expect(
      createRedactionProvenance(() => store({ breadcrumb: (b) => b })).forEntry('breadcrumbs'),
    ).toBe(true);
    // a network filter does NOT mark a log entry as redacted (per-type, not global)
    expect(createRedactionProvenance(() => store({ network: (e) => e })).forEntry('log')).toBe(
      false,
    );
  });

  it('forReport: true only when a report handler with a `before` pass is set', () => {
    expect(
      createRedactionProvenance(() => store({ report: { before: (r) => r } })).forReport(),
    ).toBe(true);
    // an after-only handler ran no before-pass before crossing → not redacted
    expect(
      createRedactionProvenance(() => store({ report: { after: () => {} } })).forReport(),
    ).toBe(false);
    expect(createRedactionProvenance(() => store()).forReport()).toBe(false);
  });

  it('returns false for everything when there is no filter store yet (undefined OR null)', () => {
    for (const empty of [undefined, null] as const) {
      const p = createRedactionProvenance(() => empty);
      expect(p.forEntry('log')).toBe(false);
      expect(p.forEntry('network')).toBe(false);
      expect(p.forReport()).toBe(false);
    }
  });

  it('reads the store LIVE on each call (a filter set after construction is observed)', () => {
    let live: FilterStore | undefined = store();
    const p = createRedactionProvenance(() => live);
    expect(p.forEntry('log')).toBe(false);
    live = store({ log: (e) => e }); // a filter is set later (e.g. via the returned client)
    expect(p.forEntry('log')).toBe(true);
  });
});
