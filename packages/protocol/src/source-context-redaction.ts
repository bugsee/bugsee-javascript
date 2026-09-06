import { isSensitiveHeader, isSensitiveKey, REDACTED } from './sensitive';
import { redactShapes } from './shapes';

// Secret redaction for a crash frame's SOURCE CONTEXT — the lines around the throwing line.
//
// THE DEFECT THIS CLOSES. Those lines shipped verbatim, so a hardcoded credential on or near the
// throwing line was disclosed in plaintext — while the SAME value held in a local variable arrived as
// `<redacted>`, because local-variable capture (packages/node/src/local-variables.ts) scrubs by key
// name. One value, two answers, decided by which feature happened to see it.
//
// WHAT "SCRUB A SOURCE LINE" MEANS HERE — two passes, both reusing definitions that already exist:
//
//  1. SENSITIVE ASSIGNMENT. A string, template or numeric LITERAL whose key/identifier satisfies
//     `isSensitiveKey` is replaced by `<redacted>`. That is the SAME predicate local-variable capture,
//     network body/query scrubbing and span sanitizing use, so the inconsistency is closed by
//     construction rather than by a second list that would drift (CLAUDE.md: "One definition of
//     sensitive field ... shape it, never restate it").
//
//  2. CREDENTIAL SHAPE. `redactShapes` — the package's existing shape pass (anchored JWT, AWS access
//     key ids, Stripe live/webhook keys, GitHub tokens), already applied to network values, error
//     messages and stack text. Reused wholesale; NO new pattern is introduced here.
//
// WHAT IS DELIBERATELY NOT DONE: entropy thresholds, "long base64/hex run", generic 32-or-40-character
// alphanumeric rules. Those are where the false positives live, and the code a crash window shows is
// exactly the code full of hashes, digests, UUIDs, minified identifiers and asset fingerprints. The
// published comparisons of secret scanners are consistent about this: entropy-and-broad-regex tools
// have high recall and low precision, and the precise rules are the ones with a provider-specific
// prefix — which is exactly the set `redactShapes` already carries. A false positive here silently
// destroys the feature (a redacted line tells the reader nothing), so the extra recall is not free.
//
// ORDER MATTERS: this runs BEFORE the caller clips a line to `maxLineLength`. Clipping first would cut
// a long line mid-secret, leaving a prefix with no closing quote for pass 1 to match and no complete
// shape for pass 2 — a truncated credential is still a credential. Clipping after means the input can
// be a whole minified bundle line, which is why the pattern below is anchored (see `SENSITIVE_ASSIGNMENT`).
//
// MIRRORED IN THE BACKGROUND WORKER. A remapped frame's window is rebuilt server-side from the
// sourcemap's `sourcesContent` (`symbolfiles/sourcemap.py`), which is the common path for web frames,
// so the same rule has a Python twin. The two are held together by the shared behavioural corpus
// `source-line-redaction.vectors.json`, which BOTH test suites run — see that file's header.

/**
 * One JS string literal, in each of the three quote styles.
 *
 * Written in Friedl's unrolled form (`[^q\\]*(?:\\[\s\S][^q\\]*)*`) rather than the lazy `(?:\\.|.)*?`:
 * the unrolled form has exactly one way to match any input, so there is nothing for the engine to
 * backtrack through. `[\s\S]` rather than `.` so an escape immediately before a newline — reachable
 * because this scans a whole multi-line window — consumes the newline instead of failing the escape.
 */
const STRING_LITERAL =
  '"[^"\\\\]*(?:\\\\[\\s\\S][^"\\\\]*)*"' +
  "|'[^'\\\\]*(?:\\\\[\\s\\S][^'\\\\]*)*'" +
  '|`[^`\\\\]*(?:\\\\[\\s\\S][^`\\\\]*)*`';

/** A numeric literal. `pin`, `cvv` and `ssn` are routinely written unquoted. */
const NUMERIC_LITERAL = '-?\\d[\\d_]*(?:\\.\\d+)?';

/**
 * `<key><separator><literal>`, ANCHORED — which is what keeps it linear.
 *
 * Group 1 is the anchor: a key starts a token, so a run of identifier characters is scanned from its
 * START and once only. Without it every offset inside one enormous minified identifier would begin a
 * fresh scan to the end of the run, which is the O(n²) `redactShapes` documents for the same reason.
 * The anchor is put back through `$1` — the pattern consumes it.
 *
 * Group 3 (the separator) accepts what a key can be followed by before its value:
 *   - `"]` / `']`  — the tail of `obj["password"]`
 *   - `"` / `'`    — the closing quote of a quoted object key
 *   - `:` or 1-3 `=`, so `:`, `=`, `==` and `===` all count.
 *
 * The separator carries an optional OPERATOR PREFIX. Without it only `:`, `=`, `==` and `===` matched,
 * so `if (password !== "hunter2")` shipped the literal while `===` redacted it — half of the comparison
 * forms this pass already claimed to cover. `!`, `||`, `&&`, `??` and `<`/`>` are accepted, which adds
 * `!=`/`!==`, the logical assignments (`||=`, `??=`, `&&=`) and `<=`/`>=`.
 *
 * Widening the prefix cannot let an arrow through, and that is structural too: `token => "x"` fails
 * because after the `=` the pattern allows only whitespace before the literal, and `>` is neither. A
 * mutation adding `=` to the prefix class SURVIVES the suite for that reason — measured, the only input
 * it changes is `a ==== "x"`, which is not valid JavaScript. It is an equivalent mutant, not a gap.
 *
 * An ARROW FUNCTION is excluded structurally rather than by a lookahead. `(?!=|>)` was written here
 * first, on the assumption that `token => "x"` would otherwise read as an assignment; the mutator loop
 * disproved it — removing the lookahead changed no test outcome, because between the `=` and the value
 * the pattern allows only whitespace, and `>` is not whitespace and cannot begin a literal. The same
 * argument covers `====`. A guard that cannot fire is not protection, so it is gone and the arrow cases
 * stay in the suite as the pins that say WHY it is safe to be absent.
 *
 * The `\]` alternative is grouped so it cannot decompose into two adjacent `\s*` — two adjacent
 * unbounded whitespace runs are ambiguous, and ambiguity is what backtracking costs.
 */
/**
 * How much TypeScript may sit between a key and its `=`.
 *
 * BOUNDED on purpose. A type annotation cannot contain `=`, so an unbounded run would be safe to
 * match but not safe to SCAN: this pattern runs globally over a window that may be a whole minified
 * bundle line, and an unbounded negated class is what turns that scan quadratic. 200 characters is
 * far past any real annotation; past it the line simply does not redact, which the linearity guards
 * exist to keep true.
 */
const MAX_TYPE_ANNOTATION = 200;

/** The assignment and comparison operators a value can follow. See the separator note below. */
const ASSIGN_OP = '(?:!|\\|\\||&&|\\?\\?|[<>])?={1,3}';

/**
 * A TypeScript type annotation, ending at the TOP-LEVEL comma that separates one parameter from the
 * next.
 *
 * A flat "anything but `=`" skip was wrong in both directions on a parameter list. It let a
 * NON-sensitive parameter's type run across the comma and match the next parameter's default —
 * `function login(user: string, password = "changeme")` matched at `user`, was returned unchanged
 * because `user` is not sensitive, and CONSUMED the region, so `password`'s default never got its own
 * look. And it did the reverse too: `function connect(password: string, host = "localhost")` reached
 * past the comma and redacted `"localhost"`, which is not a secret.
 *
 * So a comma ends the type — unless it is inside `<…>`, where it belongs to the type
 * (`Record<string, string>`, `Pick<Foo, "a" | "b">`). The two branches are DISJOINT: the first cannot
 * match `<`, so a `<` only ever starts the second, which is what keeps this linear. The inner class
 * still allows `<`/`>`, so arbitrary nesting works — only the last `>` before the operator has to line
 * up, and `Array<Record<string, string>>` does.
 */
const TYPE_ANNOTATION = `(?:[^=;,\\n<]|<[^=;\\n]{0,150}>){0,${MAX_TYPE_ANNOTATION}}`;

const SENSITIVE_ASSIGNMENT = new RegExp(
  '(^|[^A-Za-z0-9_$-])' +
    '([A-Za-z0-9_$-]+)' +
    '((?:["\']?\\s*\\])?["\']?\\s*' +
    // Ordered: a TYPED assignment must be tried before the bare `:`, or the colon binds a literal
    // TYPE and spares the value — `const apiKey: "prod" = "actual-secret"` redacted `"prod"` and
    // shipped the secret, which reads as success.
    `(?::${TYPE_ANNOTATION}${ASSIGN_OP}|:|${ASSIGN_OP})` +
    '\\s*)' +
    `(${STRING_LITERAL}|${NUMERIC_LITERAL})`,
  'g',
);

/**
 * Is this key one whose literal value must not ship?
 *
 * BOTH shared predicates, because a source line is the one place the two vocabularies meet: an object
 * literal in a `fetch` call is where a HEADER name appears as a key (`{ "x-api-key": "…" }`), and
 * `isSensitiveKey`'s substring list carries `api_key`/`apikey` but not the hyphenated header spelling.
 * Consulting `isSensitiveHeader` as well reuses the second existing definition rather than widening
 * the first — which would change what every network body and query string redacts, a separate call.
 */
function isSensitiveName(name: string): boolean {
  return isSensitiveKey(name) || isSensitiveHeader(name);
}

/**
 * `<redacted>` in place of `value`, keeping the quote style AND the number of newlines the value held.
 *
 * The newline count is load-bearing, not cosmetic: the caller splits the redacted window back into
 * lines and zips them against `pre`/`line`/`post` by position. A multi-line template literal collapsed
 * to a single `<redacted>` would shorten the window and slide every following line onto the wrong one
 * — a frame that then points at source it did not throw from, which is worse than no context at all.
 */
function redactedLiteral(value: string): string {
  let newlines = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\n') {
      newlines += '\n';
    }
  }
  const quote = value[0] as string;
  return quote === '"' || quote === "'" || quote === '`'
    ? `${quote}${REDACTED}${newlines}${quote}`
    : `${REDACTED}${newlines}`;
}

/**
 * Redact secrets from a source-context WINDOW, returning exactly as many lines as it was given.
 *
 * Window-scoped rather than line-scoped on purpose: a wrapped assignment puts the key on one line and
 * the literal on the next, and a per-line rule would read the continuation as a bare string with no
 * key to judge it by — the single most likely way a formatter hides a secret from a scrubber.
 */
export function redactSourceLines(lines: readonly string[]): string[] {
  // `[].join('\n')` is `''` and `''.split('\n')` is `['']`, so an empty window would come back as one
  // empty line and give a frame a context it does not have.
  if (lines.length === 0) {
    return [];
  }
  const assigned = lines
    .join('\n')
    .replace(
      SENSITIVE_ASSIGNMENT,
      (match, anchor: string, key: string, separator: string, value: string) =>
        isSensitiveName(key) ? `${anchor}${key}${separator}${redactedLiteral(value)}` : match,
    );
  // Neither pass can add or remove a newline — `redactShapes`'s patterns contain none and `<redacted>`
  // has none — so the split below is guaranteed to return `lines.length` entries.
  return redactShapes(assigned).split('\n');
}
