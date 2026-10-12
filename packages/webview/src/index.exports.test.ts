import { getDefaultNetworkSanitizer } from '@bugsee/capture';
import { addReportAttachment, BugseeStatus, LifecycleEvents } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import * as entry from './index';

// The package barrel hands out the umbrella's value API (review R2D-4). Loading it here also makes the barrel
// a COVERED file on a cold CI transform (see the note in @bugsee/node's index.test.ts).
describe('@bugsee/webview barrel: the shared value API', () => {
  it('re-exports the same functions and constants as core / capture', () => {
    expect(entry.addReportAttachment).toBe(addReportAttachment);
    expect(entry.BugseeStatus).toBe(BugseeStatus);
    expect(entry.LifecycleEvents).toBe(LifecycleEvents);
    expect(entry.getDefaultNetworkSanitizer).toBe(getDefaultNetworkSanitizer);
  });
});
