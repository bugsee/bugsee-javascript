import { describe, expect, it } from 'vitest';
// Type-level assertions: these imports fail `tsc --noEmit` (the typecheck gate) if the umbrella stops
// re-exporting the curated manual-instrumentation argument types — that is the "mutation catch" for a
// type-only export, which has no runtime footprint to assert on.
import type { AttributeValue, Breadcrumb, BreadcrumbInput, LogExceptionOptions } from './index';
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
});
