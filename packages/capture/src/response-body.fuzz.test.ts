import type { Interceptor } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createFetchInterceptor, type FetchTarget } from './fetch-interceptor';

/**
 * Property-based tests for bounded response-body capture.
 *
 * Two binding rules meet here. The SDK must not alter what the application observes — the app's own
 * response is returned untouched and its stream is never consumed, so capture reads a CLONE and cancels
 * its reader the moment it stops. And the byte cap is a real bound, not a hint: it is what stops a
 * multi-gigabyte download being pulled into memory and into a bundle.
 *
 * Both are claims about EVERY response shape, so they are asserted over generated chunk sequences and
 * caps rather than over a few remembered bodies.
 */

type FetchFn = (input: unknown, init?: unknown) => Promise<unknown>;
type NetIc = Interceptor<Record<NetworkStage, NetworkEvent>>;

const harness = (impl: FetchFn) => {
  let current: FetchFn = impl;
  const target: FetchTarget = {
    get: () => current,
    set: (fn) => {
      current = fn;
    },
  };
  return { target, call: (input: unknown, init?: unknown) => current(input, init) };
};

/** A response whose clone streams `chunks`, recording whether its reader was read and/or cancelled. */
const streamingResponse = (chunks: readonly Uint8Array[], contentLength?: number) => {
  const state = { reads: 0, cancelled: false, readerTaken: false };
  const makeBody = () => {
    let i = 0;
    return {
      getReader: () => {
        state.readerTaken = true;
        return {
          read: async () => {
            state.reads += 1;
            return i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true, value: undefined };
          },
          cancel: async () => {
            state.cancelled = true;
          },
        };
      },
    };
  };
  const headers = {
    forEach: (cb: (v: string, k: string) => void) => {
      cb('application/octet-stream', 'content-type');
      if (contentLength !== undefined) {
        cb(String(contentLength), 'content-length');
      }
    },
  };
  const response = {
    status: 200,
    statusText: 'OK',
    redirected: false,
    headers,
    body: makeBody(),
    clone: () => ({ status: 200, statusText: 'OK', headers, body: makeBody() }),
  };
  return { response, state };
};

const collect = (ic: NetIc): Array<{ stage: NetworkStage; event: NetworkEvent }> => {
  const events: Array<{ stage: NetworkStage; event: NetworkEvent }> = [];
  ic.onAny((stage, event) => events.push({ stage, event }));
  return events;
};

/** Wait for the body read, which the interceptor performs OFF the response path (that is the point —
 *  the caller's promise resolves without it). `setTimeout` via globalThis: this tier compiles without the
 *  DOM/Node libs. */
const { setTimeout: delay, TextDecoder: Decoder } = globalThis as unknown as {
  setTimeout: (fn: () => void, ms: number) => unknown;
  TextDecoder: new () => { decode(input: Uint8Array): string };
};
const settle = async (): Promise<void> => {
  await new Promise((resolve) => delay(() => resolve(undefined), 0));
  await new Promise((resolve) => delay(() => resolve(undefined), 0));
};

/** The captured body arrives on the OVERRIDE `complete` event, under `custom`. */
const capturedBody = (
  events: ReadonlyArray<{ stage: NetworkStage; event: NetworkEvent }>,
): { body?: string; reason?: string } => {
  const override = events.filter((e) => e.stage === 'complete').at(-1)?.event as
    | { custom?: { body?: string; no_body_reason?: string } }
    | undefined;
  return { body: override?.custom?.body, reason: override?.custom?.no_body_reason };
};

const chunk = (size: number, seed: number): Uint8Array =>
  new Uint8Array(size).map((_v, i) => (seed + i) % 256);

describe('bounded response-body capture (fuzz)', () => {
  /**
   * The cap is a BOUND: a body over it is refused with `size_too_large` and never captured, and the
   * reader is cancelled rather than drained. Under the cap, the exact bytes come back.
   */
  it('captures a body under the cap and refuses one over it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 8, max: 120 }),
        async (sizes, maxBodySize) => {
          const chunks = sizes.map((s, i) => chunk(s, i));
          const total = sizes.reduce((a, b) => a + b, 0);
          const { response, state } = streamingResponse(chunks);
          const { target, call } = harness(async () => response);
          const ic = createFetchInterceptor({
            target,
            maxBodyBytes: maxBodySize,
            captureBodies: true,
          });
          const events = collect(ic);

          const returned = await call('https://api.example.com/data');
          // The application's own response object is handed back untouched.
          expect(returned).toBe(response);
          await settle();

          const captured = capturedBody(events);
          if (total > maxBodySize) {
            expect(captured.body, 'an over-cap body was captured').toBeUndefined();
            expect(captured.reason).toBe('size_too_large');
            expect(state.cancelled, 'an over-cap read was not cancelled').toBe(true);
          } else {
            // The captured text is exactly the bytes the stream produced.
            const expected = new Decoder().decode(new Uint8Array(chunks.flatMap((c) => [...c])));
            expect(captured.body).toBe(expected);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  /**
   * The Content-Length fast-skip: a response ANNOUNCING more than the cap is never read at all. That is
   * not merely an optimisation — reading it would pull the whole body through memory before discovering
   * what the header already said.
   */
  it('never touches the stream when Content-Length already exceeds the cap', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 8, max: 64 }),
        fc.integer({ min: 1, max: 500 }),
        async (maxBodySize, over) => {
          const announced = maxBodySize + over;
          const { response, state } = streamingResponse([chunk(4, 1)], announced);
          const { target, call } = harness(async () => response);
          const ic = createFetchInterceptor({
            target,
            maxBodyBytes: maxBodySize,
            captureBodies: true,
          });
          collect(ic);

          await call('https://api.example.com/big');
          await settle();

          expect(state.readerTaken, 'the stream was read despite an over-cap Content-Length').toBe(
            false,
          );
          expect(state.reads).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * A stream that ERRORS mid-read must not surface as a failed fetch. The application already has its
   * response; capture is a bystander, and the binding rule is that instrumentation never alters what the
   * application observes.
   */
  it('survives a stream that throws, without disturbing the caller', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (failAfter) => {
        let reads = 0;
        let cancelled = false;
        const headers = {
          forEach: (cb: (v: string, k: string) => void) => cb('text/plain', 'content-type'),
        };
        const body = () => ({
          getReader: () => ({
            read: async () => {
              reads += 1;
              if (reads > failAfter) {
                throw new Error('stream exploded');
              }
              return { done: false, value: chunk(4, reads) };
            },
            cancel: async () => {
              cancelled = true;
            },
          }),
        });
        const response = {
          status: 200,
          statusText: 'OK',
          redirected: false,
          headers,
          body: body(),
          clone: () => ({ status: 200, statusText: 'OK', headers, body: body() }),
        };
        const { target, call } = harness(async () => response);
        const ic = createFetchInterceptor({ target, maxBodyBytes: 1024, captureBodies: true });
        const events = collect(ic);

        // The caller's fetch resolves normally with the untouched response.
        await expect(call('https://api.example.com/flaky')).resolves.toBe(response);
        await settle();

        // Capture degraded rather than throwing, and released the reader.
        const captured = capturedBody(events);
        expect(captured.body).toBeUndefined();
        expect(captured.reason).toBe('cant_read_data');
        expect(cancelled).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  // A response with no body at all (204, HEAD) is not a failure and not a reason.
  it('reports nothing for a response with no body', async () => {
    const headers = {
      forEach: (cb: (v: string, k: string) => void) => cb('text/plain', 'content-type'),
    };
    const response = {
      status: 204,
      statusText: 'No Content',
      redirected: false,
      headers,
      body: null,
      clone: () => ({ status: 204, statusText: 'No Content', headers, body: null }),
    };
    const { target, call } = harness(async () => response);
    const ic = createFetchInterceptor({ target, maxBodyBytes: 1024, captureBodies: true });
    const events = collect(ic);
    await call('https://api.example.com/none');
    await settle();
    expect(capturedBody(events).body).toBeUndefined();
  });
});
