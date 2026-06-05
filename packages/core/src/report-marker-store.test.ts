import { describe, expect, it } from 'vitest';
import { ReportMarkerStoreToken } from './report-marker-store';

describe('ReportMarkerStoreToken', () => {
  it('is a service token named reportMarkerStore', () => {
    expect(ReportMarkerStoreToken.name).toBe('reportMarkerStore');
  });
});
