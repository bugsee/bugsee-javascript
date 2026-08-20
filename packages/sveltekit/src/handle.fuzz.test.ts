// Property tests for `injectTraceMeta` — the shared SSR `<head>` splice used by BOTH the node `handle`
// (`createHandle`) and the edge one (`createEdgeHandle`).
//
// It rewrites arbitrary framework-produced HTML, so the contract is stated as an independent MODEL
// (indexOf/slice) rather than a restatement of the implementation (String#replace): insert the tag
// immediately before the FIRST `</head>`, change nothing else, and never lose a character.
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

const { traceMetaTag } = vi.hoisted(() => ({
  traceMetaTag: vi.fn<(options?: { getClient?: () => unknown }) => string>(() => ''),
}));
vi.mock('@bugsee/adapter-kit', () => ({ traceMetaTag }));

import { injectTraceMeta } from './handle';

/** A traceparent `<meta>` as `@bugsee/adapter-kit` renders it (W3C hex ids — the only shape reachable
 *  at runtime, since `parseTraceparent` hex-validates every inbound header). */
const hex = (n: number) =>
  fc
    .array(fc.constantFrom(...'0123456789abcdef'), { minLength: n, maxLength: n })
    .map((a) => a.join(''));
const metaTag = fc
  .tuple(hex(32), hex(16))
  .map(([t, s]) => `<meta name="traceparent" content="00-${t}-${s}-01">`);

/** Arbitrary HTML that never accidentally contains the marker we splice on. */
const htmlPart = fc.string({ maxLength: 60 }).filter((s) => !s.includes('</head>'));

/** The reference model, written independently of the implementation. */
const model = (html: string, tag: string): string => {
  const i = html.indexOf('</head>');
  if (i === -1 || tag === '') return html;
  return `${html.slice(0, i)}${tag}${html.slice(i)}`;
};

describe('injectTraceMeta — properties', () => {
  it('matches the reference model for any HTML / any active-or-absent trace', () => {
    fc.assert(
      fc.property(
        fc.array(htmlPart, { minLength: 1, maxLength: 4 }),
        fc.oneof(fc.constant(''), metaTag),
        (parts, tag) => {
          traceMetaTag.mockReturnValue(tag);
          const html = parts.join('</head>');
          expect(injectTraceMeta(html, {})).toBe(model(html, tag));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is loss-free: deleting the injected tag restores the input exactly', () => {
    fc.assert(
      fc.property(htmlPart, htmlPart, metaTag, (head, tail, tag) => {
        traceMetaTag.mockReturnValue(tag);
        const html = `${head}</head>${tail}`;
        const out = injectTraceMeta(html, {});
        expect(out.replace(tag, '')).toBe(html);
        expect(out.split('name="traceparent"').length - 1).toBe(1); // injected exactly once
      }),
      { numRuns: 200 },
    );
  });

  it('never reads the trace for a chunk with no </head> (no per-body-chunk context lookup)', () => {
    fc.assert(
      fc.property(htmlPart, (html) => {
        traceMetaTag.mockClear();
        traceMetaTag.mockReturnValue('<meta name="traceparent" content="00-a-b-01">');
        expect(injectTraceMeta(html, {})).toBe(html);
        expect(traceMetaTag).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it('threads the caller options straight through to the trace read', () => {
    const getClient = () => ({ id: 'c' }) as never;
    traceMetaTag.mockReturnValue('');
    injectTraceMeta('<head></head>', { getClient });
    expect(traceMetaTag).toHaveBeenLastCalledWith({ getClient });
  });
});
