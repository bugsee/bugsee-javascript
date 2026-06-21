import type { AttributeValue } from '@bugsee/types';
import { describe, expect, it } from 'vitest';
import { type ContextProvider, ContextProviderToken, type RequestContext } from './request-context';

describe('request-context contracts', () => {
  it('mints a stable ContextProviderToken named "context-provider"', () => {
    expect(ContextProviderToken.name).toBe('context-provider');
  });

  it('models a RequestContext carrying contextId, user, attributes, and the active trace', () => {
    const attributes: Record<string, AttributeValue> = {
      'http.method': 'GET',
      retries: 2,
      sampled: true,
      labels: ['a', 'b'],
    };
    const ctx: RequestContext = {
      contextId: 'ctx-1',
      user: 'alice@example.com',
      attributes,
      trace: { traceId: 't1', spanId: 's1', sampled: true },
    };
    expect(ctx.contextId).toBe('ctx-1');
    expect(ctx.user).toBe('alice@example.com');
    expect(ctx.attributes).toBe(attributes);
    expect(ctx.trace).toEqual({ traceId: 't1', spanId: 's1', sampled: true });
  });

  it('a ContextProvider returns the active RequestContext, or undefined when none is open', () => {
    let current: RequestContext | undefined;
    const provider: ContextProvider = { getCurrent: () => current };

    expect(provider.getCurrent()).toBeUndefined();

    const ctx: RequestContext = { contextId: 'ctx-2' };
    current = ctx;
    expect(provider.getCurrent()).toBe(ctx);
    expect(provider.getCurrent()?.contextId).toBe('ctx-2');
  });
});
