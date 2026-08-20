// Property tests for the node SSR stream transformer (R3, node half).
//
// The transformer sits in the middle of React's `renderToPipeableStream` pipe, so it handles EVERY byte the
// framework streams to the client. Two contracts matter more than the injection itself:
//   1. a chunk it does not inject into is forwarded BYTE-EXACT (never decoded → re-encoded — that would
//      mangle any chunk whose bytes are not, on their own, valid UTF-8);
//   2. the whole stream is otherwise preserved — nothing dropped, reordered or duplicated.
// Example-based tests read the output back through `chunk.toString()`, which cannot see either violation;
// these compare raw bytes.
import { Writable } from 'node:stream';
import { type ContextProvider, setCarrierClient } from '@bugsee/core';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { getBugseeMetaTagTransformer } from './meta-tag-transformer';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const META = `<meta name="traceparent" content="00-${TRACE_ID}-${SPAN_ID}-01">`;

function clientWith(provider: ContextProvider | null) {
  return { getServiceProvider: () => ({ getImmediate: () => provider }) } as never;
}
const tracedClient = () =>
  clientWith({
    getCurrent: () => ({
      contextId: 'c1',
      trace: { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true },
    }),
  });
const untracedClient = () => clientWith(null);

/** Pipe `chunks` through a transformer built for `client` and return the raw bytes it produced. */
async function pump(client: unknown, chunks: readonly Buffer[]): Promise<Buffer> {
  const out: Buffer[] = [];
  const body = new Writable({
    write(chunk: Buffer, _enc, cb) {
      out.push(Buffer.from(chunk));
      cb();
    },
  });
  const t = getBugseeMetaTagTransformer(body, { getClient: () => client as never });
  await new Promise<void>((resolve) => {
    body.on('finish', () => resolve());
    for (const c of chunks) t.write(c);
    t.end();
  });
  return Buffer.concat(out);
}

/** Bytes that are NOT valid UTF-8 on their own (a lone continuation byte + a truncated 3-byte sequence) —
 *  exactly what a chunk boundary that splits a multi-byte character produces. */
const RAW = fc
  .uint8Array({ minLength: 0, maxLength: 24 })
  .map((a) => Buffer.from(a))
  .filter((b) => !b.includes(Buffer.from('</head>')));

describe('getBugseeMetaTagTransformer — stream properties', () => {
  afterEach(() => setCarrierClient(undefined));

  it('forwards every byte untouched when no trace is active, whatever the chunks contain', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(RAW, { minLength: 1, maxLength: 4 }), async (raw) => {
        // Splice `</head>` into the stream so the injection branch is the one under test.
        const chunks = raw.map((b) => Buffer.concat([b, Buffer.from('</head>'), b]));
        const out = await pump(untracedClient(), chunks);
        expect(out.equals(Buffer.concat(chunks))).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('forwards a chunk with no </head> byte-exact even while a trace IS active', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(RAW, { minLength: 1, maxLength: 4 }), async (chunks) => {
        const out = await pump(tracedClient(), chunks);
        expect(out.equals(Buffer.concat(chunks))).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('injects the meta exactly once per </head>-bearing chunk, before the FIRST </head>', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 40 }).filter((s) => !s.includes('</head>')),
        fc.string({ maxLength: 40 }).filter((s) => !s.includes('</head>')),
        async (head, tail) => {
          const html = `${head}</head>${tail}`;
          const out = (await pump(tracedClient(), [Buffer.from(html, 'utf8')])).toString('utf8');
          // Model the injection independently (indexOf/slice, not String#replace).
          const i = html.indexOf('</head>');
          expect(out).toBe(`${html.slice(0, i)}${META}${html.slice(i)}`);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('preserves the stream: removing the injected meta yields the original bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(RAW, { minLength: 1, maxLength: 3 }), async (raw) => {
        const chunks = [Buffer.from('<html><head></head>', 'utf8'), ...raw];
        const out = await pump(tracedClient(), chunks);
        const stripped = Buffer.from(out.toString('binary').replace(META, ''), 'binary');
        expect(stripped.equals(Buffer.concat(chunks))).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  // Generation can reach these, but pin them so the byte-exactness contract has a deterministic witness.
  it('does not mangle a chunk whose bytes are not valid UTF-8 (split multi-byte char)', async () => {
    const split = Buffer.from([0xe2, 0x82]); // first two bytes of '€' — the third landed in the next chunk
    expect(
      (await pump(untracedClient(), [Buffer.concat([split, Buffer.from('</head>')])])).equals(
        Buffer.concat([split, Buffer.from('</head>')]),
      ),
    ).toBe(true);
    expect((await pump(tracedClient(), [split])).equals(split)).toBe(true);
  });
});
