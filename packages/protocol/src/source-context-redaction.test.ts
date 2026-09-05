import { describe, expect, it } from 'vitest';
import ARTIFACT from '../source-line-redaction.vectors.json';
import { REDACTED, redactSourceLines, SENSITIVE_HEADERS, SENSITIVE_KEY_SUBSTRINGS } from './index';
import { expectLinearIn } from './linear-time.test-helper';

// The corpus is the CROSS-REPO drift guard. Both this suite and the background worker's
// `test_source_line_redaction.py` run the SAME file, so the two implementations of this rule cannot
// disagree without one of the two CIs going red. See `source-line-redaction.vectors.json`.
//
// IMPORTED, not read off disk: this package compiles with `types: []` and `lib: ["ES2023"]` — no Node,
// no DOM — which is the rule that keeps a runtime-portable tier portable, and a test is not an excuse
// to break it. The one check that genuinely needs a filesystem (does the worker's vendored copy still
// match?) therefore lives in `@bugsee/node`, next to the SDK-side producer of these windows.

interface Vector {
  readonly name: string;
  readonly lines: readonly string[];
  readonly expected: readonly string[];
}

const DOC = ARTIFACT as {
  definitions: { sensitiveKeySubstrings: string[]; sensitiveHeaders: string[] };
  vectors: Vector[];
};
const vectors: readonly Vector[] = DOC.vectors;

describe('the shared artifact cannot drift from this package', () => {
  // The artifact carries the denylists so the worker can READ them instead of restating them — which
  // only helps if the artifact itself still says what `sensitive.ts` says. These two assertions are the
  // in-repo half of the drift guard; the cross-repo half is the vendored-copy check below.
  it('carries exactly the key substrings this package defines, in order', () => {
    expect(DOC.definitions.sensitiveKeySubstrings).toEqual([...SENSITIVE_KEY_SUBSTRINGS]);
  });

  it('carries exactly the sensitive headers this package defines', () => {
    expect(DOC.definitions.sensitiveHeaders).toEqual([...SENSITIVE_HEADERS].sort());
  });
});

describe('redactSourceLines — the shared cross-repo corpus', () => {
  it('has vectors at all, so an empty file cannot pass as agreement', () => {
    expect(vectors.length).toBeGreaterThan(25);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    expect(redactSourceLines(vector.lines)).toEqual([...vector.expected]);
  });
});

describe('redactSourceLines — assignment to a sensitive identifier', () => {
  it.each([
    ['const', `const apiKey = "sk-live-abcdef";`, `const apiKey = "${REDACTED}";`],
    ['let', `let password = 'hunter2';`, `let password = '${REDACTED}';`],
    ['var, backtick', 'var secret = `s3cr3t`;', `var secret = \`${REDACTED}\`;`],
    ['bare re-assign', `apiKey = "abc";`, `apiKey = "${REDACTED}";`],
    ['object key, unquoted', `{ apiKey: 'abc' }`, `{ apiKey: '${REDACTED}' }`],
    ['object key, quoted', `{ "password": "abc" }`, `{ "password": "${REDACTED}" }`],
    ['object key, single-quoted', `{ 'token': "abc" }`, `{ 'token': "${REDACTED}" }`],
    ['dotted property', `config.apiKey = "abc";`, `config.apiKey = "${REDACTED}";`],
    ['this property', `this.password = "abc";`, `this.password = "${REDACTED}";`],
    ['env lookup shape', `process.env.API_KEY = "abc";`, `process.env.API_KEY = "${REDACTED}";`],
    ['bracket property', `obj["password"] = "abc";`, `obj["password"] = "${REDACTED}";`],
    ['default parameter', `function f(apiKey = "abc") {}`, `function f(apiKey = "${REDACTED}") {}`],
    ['strict equality', `if (password === "abc") {}`, `if (password === "${REDACTED}") {}`],
    ['loose equality', `if (token == "abc") {}`, `if (token == "${REDACTED}") {}`],
    ['dashed key', `{ "x-api-key": "abc" }`, `{ "x-api-key": "${REDACTED}" }`],
    ['numeric literal', `const cvv = 123;`, `const cvv = ${REDACTED};`],
    ['negative numeric', `const pin = -1234;`, `const pin = ${REDACTED};`],
    ['decimal numeric', `const pin = 12.5;`, `const pin = ${REDACTED};`],
  ])('redacts %s', (_case, input, expected) => {
    expect(redactSourceLines([input])).toEqual([expected]);
  });

  it('redacts EVERY sensitive assignment on one line, not just the first', () => {
    expect(redactSourceLines([`{ apiKey: "a", user: "u", password: "p" }`])).toEqual([
      `{ apiKey: "${REDACTED}", user: "u", password: "${REDACTED}" }`,
    ]);
  });

  it('keeps the value when the identifier is not sensitive', () => {
    expect(redactSourceLines([`const greeting = "hello sk-live";`])).toEqual([
      `const greeting = "hello sk-live";`,
    ]);
  });

  it('does not treat an arrow function as an assignment', () => {
    // `=>` must not read as `=`, or every one-line arrow returning a constant would be redacted.
    // A PARENTHESISED parameter list is not the case that exercises the guard — the `)` between the
    // name and the `=>` already blocks the match — so the bare single-parameter form is the one that
    // pins it, and the parenthesised form rides along to show the common spelling is safe too.
    expect(redactSourceLines([`items.map((token) => "x")`])).toEqual([`items.map((token) => "x")`]);
    expect(redactSourceLines([`items.map(token => "x")`])).toEqual([`items.map(token => "x")`]);
    expect(redactSourceLines([`const f = password => "x";`])).toEqual([
      `const f = password => "x";`,
    ]);
  });

  it('leaves a non-literal right-hand side alone', () => {
    // Redacting an identifier or a call discloses nothing and destroys the only useful part of the line.
    expect(redactSourceLines([`const apiKey = readKeyFromVault();`])).toEqual([
      `const apiKey = readKeyFromVault();`,
    ]);
  });

  it('does not match a sensitive substring glued to a longer run to its LEFT', () => {
    // The anchor: `notapass` is one identifier, and `isSensitiveKey` sees the whole of it (which does
    // match, by substring) — the point is that the scan starts at the run, not inside it.
    expect(redactSourceLines([`const xpasswordx = "abc";`])).toEqual([
      `const xpasswordx = "${REDACTED}";`,
    ]);
  });

  it('keeps escaped quotes inside a redacted literal from ending it early', () => {
    expect(redactSourceLines([`const password = "a\\"b";`])).toEqual([
      `const password = "${REDACTED}";`,
    ]);
  });

  it('over-redacts an ordinary identifier that CONTAINS a sensitive substring', () => {
    // Documented cost of the ONE shared definition (`isSensitiveKey`, substring-matched): `author`
    // contains `auth`. Narrowing it here would create the second definition CLAUDE.md forbids.
    expect(redactSourceLines([`const author = "Ada";`])).toEqual([`const author = "${REDACTED}";`]);
  });
});

describe('redactSourceLines — credential shapes with no sensitive key name', () => {
  it.each([
    [
      'JWT',
      `fetch(url, { headers: { a: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc" } })`,
      `fetch(url, { headers: { a: "${REDACTED}" } })`,
    ],
    ['AWS access key id', `const id = "AKIAIOSFODNN7EXAMPLE";`, `const id = "${REDACTED}";`],
    ['Stripe live key', `stripe("sk_live_4eC39HqLyjWDarjtT1zdp7dc");`, `stripe("${REDACTED}");`],
    [
      'GitHub token',
      `const t = "ghp_016C7869B9C1E0B9A1C6D0E5F4A3B2C1D0E9F8";`,
      `const t = "${REDACTED}";`,
    ],
  ])('redacts a %s anywhere on the line', (_case, input, expected) => {
    expect(redactSourceLines([input])).toEqual([expected]);
  });

  it('leaves a long ordinary hex string alone — no entropy heuristic', () => {
    // The DELIBERATE limit. See the module header: entropy thresholds mis-fire on hashes, minified
    // bundles, UUIDs and asset digests, which is most of the code a crash window ever shows.
    const line = `const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";`;
    expect(redactSourceLines([line])).toEqual([line]);
  });
});

describe('redactSourceLines — window shape', () => {
  it('returns exactly as many lines as it was given', () => {
    const input = [`a`, `const password = "p";`, `b`];
    expect(redactSourceLines(input)).toHaveLength(3);
  });

  it('returns an empty array for an empty window rather than one empty line', () => {
    expect(redactSourceLines([])).toEqual([]);
  });

  it('preserves a blank line rather than collapsing it', () => {
    expect(redactSourceLines([``, `x`, ``])).toEqual([``, `x`, ``]);
  });

  it('redacts a value that sits on the line AFTER its key, keeping the line count', () => {
    // The window is scanned whole, so a wrapped assignment cannot hide a secret on a continuation line.
    expect(redactSourceLines([`const apiKey =`, `  "sk-live-abcdef";`])).toEqual([
      `const apiKey =`,
      `  "${REDACTED}";`,
    ]);
  });

  it('preserves the line count of a redacted MULTI-LINE template literal', () => {
    const out = redactSourceLines(['const secret = `a', 'b', 'c`;', 'after']);
    expect(out).toHaveLength(4);
    expect(out[3]).toBe('after');
    expect(out.join('\n')).toContain(REDACTED);
    expect(out.join('\n')).not.toContain('b');
  });

  it('does not leak across the window boundary: a lone closing quote stays literal', () => {
    expect(redactSourceLines([`const password = "abc";`, `const other = "keep";`])).toEqual([
      `const password = "${REDACTED}";`,
      `const other = "keep";`,
    ]);
  });

  it('does not mutate the array it was given', () => {
    const input = [`const password = "p";`];
    redactSourceLines(input);
    expect(input).toEqual([`const password = "p";`]);
  });
});

describe('redactSourceLines — cost on hostile input', () => {
  // This runs BEFORE the SDK clips a line to 200 characters (a secret past the clip point would be cut
  // in half and ship as a prefix otherwise), so the input can be a whole minified bundle line.
  it('is linear in the length of one enormous identifier run', () => {
    // The shape the anchor exists for: without it every offset inside the run starts a fresh scan.
    expectLinearIn(
      (n) => [`${'a'.repeat(n)};`],
      (window) => {
        redactSourceLines(window);
      },
      128_000,
    );
  }, 30_000);

  it('is linear in the length of whitespace between a sensitive key and its operator', () => {
    // Two adjacent unbounded whitespace runs in the separator would backtrack here.
    expectLinearIn(
      (n) => [`password${' '.repeat(n)}= x`],
      (window) => {
        redactSourceLines(window);
      },
      128_000,
    );
  }, 30_000);

  it('is linear in the length of an unterminated string literal', () => {
    // A quote with no partner makes the unrolled literal scan to end-of-input and fail, at every
    // sensitive key before it.
    expectLinearIn(
      (n) => [`password = "${'x'.repeat(n)}`],
      (window) => {
        redactSourceLines(window);
      },
      128_000,
    );
  }, 30_000);
});
