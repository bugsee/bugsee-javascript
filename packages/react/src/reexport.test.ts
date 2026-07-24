import * as umbrella from '@bugsee/bugsee';
import { describe, expect, it } from 'vitest';
// Namespace imports so a missing re-export surfaces as `undefined` (a clean assertion failure) rather
// than a module-resolution error — the mutation catch for `export * from '@bugsee/bugsee'`.
import * as adapter from './index';

describe('@bugsee/react single-install re-export', () => {
  it('re-exports launch so @bugsee/bugsee need not be installed separately', () => {
    expect(adapter.launch).toBe(umbrella.launch);
    expect(typeof adapter.launch).toBe('function');
  });

  it('keeps its own React surface alongside the re-exported SDK', () => {
    expect(typeof adapter.BugseeErrorBoundary).toBe('function');
  });
});
