import { Writable } from 'node:stream';
import { type ContextProvider, setCarrierClient } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import { getBugseeMetaTagTransformer } from './meta-tag-transformer';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const META = `<meta name="traceparent" content="00-${TRACE_ID}-${SPAN_ID}-01">`;

function clientWith(provider: ContextProvider | null) {
  return { getServiceProvider: () => ({ getImmediate: () => provider }) } as never;
}
function tracedClient() {
  const provider: ContextProvider = {
    getCurrent: () => ({
      contextId: 'c1',
      trace: { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true },
    }),
  };
  return clientWith(provider);
}

function collectingBody() {
  const out: string[] = [];
  const body = new Writable({
    write(chunk, _enc, cb) {
      out.push(chunk.toString());
      cb();
    },
  });
  return { body, read: () => out.join('') };
}

describe('getBugseeMetaTagTransformer', () => {
  afterEach(() => setCarrierClient(undefined));

  it('injects the traceparent <meta> immediately before </head>', async () => {
    const client = tracedClient();
    const { body, read } = collectingBody();
    const t = getBugseeMetaTagTransformer(body, { getClient: () => client });
    await new Promise<void>((resolve) => {
      body.on('finish', () => resolve());
      t.write('<html><head><title>x</title></head><body>hi</body></html>');
      t.end();
    });
    expect(read()).toBe(`<html><head><title>x</title>${META}</head><body>hi</body></html>`);
  });

  it('passes the HTML through UNCHANGED when no trace is active', async () => {
    const { body, read } = collectingBody();
    const t = getBugseeMetaTagTransformer(body, { getClient: () => clientWith(null) });
    await new Promise<void>((resolve) => {
      body.on('finish', () => resolve());
      t.write('<html><head></head><body>hi</body></html>');
      t.end();
    });
    expect(read()).toBe('<html><head></head><body>hi</body></html>');
  });

  it('passes a chunk with no </head> through unchanged (injects only in the head chunk)', async () => {
    const client = tracedClient();
    const { body, read } = collectingBody();
    const t = getBugseeMetaTagTransformer(body, { getClient: () => client });
    await new Promise<void>((resolve) => {
      body.on('finish', () => resolve());
      t.write('<html><head></head>'); // head chunk → meta injected
      t.write('<body>streamed</body></html>'); // body chunk → untouched
      t.end();
    });
    expect(read()).toBe(`<html><head>${META}</head><body>streamed</body></html>`);
  });
});
