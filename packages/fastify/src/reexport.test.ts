import * as umbrella from '@bugsee/bugsee/node';
import { describe, expect, it } from 'vitest';
// Namespace imports so a missing re-export surfaces as `undefined` (a clean assertion failure) rather
// than a module-resolution error — the mutation catch for the re-export.
import * as adapter from './index';

describe('@bugsee/fastify single-install re-export', () => {
  it('re-exports launch so the umbrella need not be installed separately', () => {
    expect(adapter.launch).toBe(umbrella.launch);
    expect(typeof adapter.launch).toBe('function');
  });
});
