import { afterEach, describe, expect, it, vi } from 'vitest';

// Control the shared-kit traceMetaTag so we assert exactly what gets spliced into the SSR <head>.
const { traceMetaTag } = vi.hoisted(() => ({
  traceMetaTag: vi.fn<(options?: { getClient?: () => unknown }) => string>(() => ''),
}));
vi.mock('@bugsee/adapter-kit', () => ({ traceMetaTag }));

import { createHandle, handle, type SvelteKitResolveOptions } from './handle';

/** A fake SvelteKit `resolve` that captures the options + returns a sentinel Response. */
function fakeResolve() {
  const sentinel = { sentinel: 'response' };
  const resolve = vi.fn((_event: unknown, opts?: SvelteKitResolveOptions) => {
    return { ...sentinel, opts };
  });
  return { resolve, sentinel };
}

const PAGE = '<html><head><title>x</title></head><body>hi</body></html>';

describe('createHandle', () => {
  afterEach(() => {
    traceMetaTag.mockReset();
    traceMetaTag.mockReturnValue('');
  });

  it('calls resolve(event, { transformPageChunk }) and returns its result', async () => {
    const { resolve } = fakeResolve();
    const event = { id: 'evt' };
    const result = await createHandle()({ event, resolve });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toBe(event); // the SvelteKit event, forwarded
    expect(typeof resolve.mock.calls[0]?.[1]?.transformPageChunk).toBe('function');
    expect(result).toMatchObject({ sentinel: 'response' });
  });

  it('splices the trace <meta> before </head> when a trace is active', async () => {
    traceMetaTag.mockReturnValue('<meta name="traceparent" content="00-t-s-01">');
    const { resolve } = fakeResolve();
    await createHandle()({ event: {}, resolve });
    const transform = resolve.mock.calls[0]?.[1]?.transformPageChunk as (i: {
      html: string;
    }) => string;

    expect(transform({ html: PAGE })).toBe(
      '<html><head><title>x</title><meta name="traceparent" content="00-t-s-01"></head><body>hi</body></html>',
    );
  });

  it('leaves the chunk unchanged when no trace is active (traceMetaTag → "")', async () => {
    const { resolve } = fakeResolve();
    await createHandle()({ event: {}, resolve });
    const transform = resolve.mock.calls[0]?.[1]?.transformPageChunk as (i: {
      html: string;
    }) => string;
    expect(transform({ html: PAGE })).toBe(PAGE);
  });

  it('leaves a chunk WITHOUT </head> unchanged even with an active trace', async () => {
    traceMetaTag.mockReturnValue('<meta name="traceparent" content="x">');
    const { resolve } = fakeResolve();
    await createHandle()({ event: {}, resolve });
    const transform = resolve.mock.calls[0]?.[1]?.transformPageChunk as (i: {
      html: string;
    }) => string;
    expect(transform({ html: '<body>no head here</body>' })).toBe('<body>no head here</body>');
    // The trace is NOT even computed for a chunk with no </head> (the guard skips the read).
    expect(traceMetaTag).not.toHaveBeenCalled();
  });

  it('reads the trace through the provided getClient', async () => {
    const client = { id: 'c' };
    const { resolve } = fakeResolve();
    await createHandle({ getClient: () => client as never })({ event: {}, resolve });
    const transform = resolve.mock.calls[0]?.[1]?.transformPageChunk as (i: {
      html: string;
    }) => string;
    transform({ html: PAGE });
    expect(traceMetaTag.mock.calls[0]?.[0]?.getClient?.()).toBe(client);
  });

  it('exports a ready-made handle bound to the carrier client', () => {
    traceMetaTag.mockReturnValue('<meta name="traceparent" content="00-t-s-01">');
    const { resolve } = fakeResolve();
    handle({ event: { id: 'evt' }, resolve });
    const transform = resolve.mock.calls[0]?.[1]?.transformPageChunk as (i: {
      html: string;
    }) => string;
    expect(transform({ html: PAGE })).toContain('<meta name="traceparent" content="00-t-s-01">');
    // "Bound to the carrier client" means it passes NO getClient — traceMetaTag then falls back to the
    // process/isolate carrier singleton itself.
    expect(traceMetaTag.mock.calls[0]?.[0]?.getClient).toBeUndefined();
  });
});
