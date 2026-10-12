import { addReportAttachment } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import * as browserEntry from './index';

describe('@bugsee/browser entry', () => {
  it('re-exports addReportAttachment (the same function as core)', () => {
    expect(browserEntry.addReportAttachment).toBe(addReportAttachment);
  });
});
