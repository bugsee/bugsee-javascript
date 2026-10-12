import { getDefaultNetworkSanitizer } from '@bugsee/bugsee/node';
import { describe, expect, it } from 'vitest';
import * as server from './server';

// The server entry of a meta-framework adapter is where its users compose Bugsee, so it must hand them the
// built-in network redaction too: a custom `setNetworkEventFilter` REPLACES the default sanitizer, and
// without this export they would have to reach past the adapter to keep it.
describe('server entry re-exports the default network sanitizer', () => {
  it('exposes the same getDefaultNetworkSanitizer as @bugsee/bugsee/node', () => {
    expect(server.getDefaultNetworkSanitizer).toBe(getDefaultNetworkSanitizer);
    expect(
      server.getDefaultNetworkSanitizer().sanitizeUrl('https://a.test/x?token=SECRET'),
    ).not.toContain('SECRET');
  });
});
