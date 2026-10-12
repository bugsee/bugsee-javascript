import { describe, expect, it } from 'vitest';
// Type-level assertions: these imports fail `tsc --noEmit` (the typecheck gate) if the umbrella stops
// re-exporting the curated manual-instrumentation argument types — that is the "mutation catch" for a
// type-only export, which has no runtime footprint to assert on.
import type {
  AttributeValue,
  Breadcrumb,
  BreadcrumbInput,
  LifecycleEventsListener,
  LifecycleEventType,
  LogExceptionOptions,
  ReportDialogOptions,
  ReportDialogStrings,
  UploadOptions,
} from './index';
import * as publicApi from './index';

describe('@bugsee/bugsee public API surface', () => {
  it('exposes launch as the composition root', () => {
    expect(typeof publicApi.launch).toBe('function');
  });

  it('re-exports the manual-instrumentation argument types', () => {
    // The `as` casts require the imported types to exist; removing any re-export breaks the typecheck.
    const attr = 'value' as AttributeValue;
    const input = {} as BreadcrumbInput;
    const crumb = {} as Breadcrumb;
    const options = {} as LogExceptionOptions;
    expect([attr, input, crumb, options]).toHaveLength(4);
  });

  it('re-exports the types of the manual-report API (upload) and of the report dialog', () => {
    const upload = {} as UploadOptions;
    const dialog = {} as ReportDialogOptions;
    const strings = {} as ReportDialogStrings;
    expect([upload, dialog, strings]).toHaveLength(3);
  });

  it('re-exports the lifecycle event constants and listener types', () => {
    const listener: LifecycleEventsListener = () => {};
    const type: LifecycleEventType = publicApi.LifecycleEvents.Launched;
    expect(type).toBe('com.bugsee.lifecycle.Launched');
    expect(publicApi.LifecycleEvents.AfterReportUploaded).toBe(
      'com.bugsee.lifecycle.AfterReportUploaded',
    );
    expect(typeof listener).toBe('function');
  });
});
