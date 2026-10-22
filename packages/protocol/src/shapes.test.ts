import { describe, expect, it } from 'vitest';
import { redactShapes, unfinishedSecretStart } from './index';
import { compileShapePattern } from './shapes';

const R = '<redacted>';

describe('redactShapes', () => {
  it('redacts a JWT embedded in text', () => {
    expect(redactShapes('auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N')).toBe(
      `auth ${R}`,
    );
  });

  it('does not redact a two-segment JWT-like string (three segments required)', () => {
    expect(redactShapes('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0')).toBe(
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0',
    );
  });

  it('does not redact a three-segment token without the eyJ header prefix', () => {
    expect(redactShapes('abc.def.ghi')).toBe('abc.def.ghi');
  });

  // Each AWS prefix alternative (AKIA/ASIA/AGPA/AIDA/AROA) + 16 trailing chars must redact.
  it.each(['AKIA', 'ASIA', 'AGPA', 'AIDA', 'AROA'])('redacts an AWS %s access key id', (prefix) => {
    expect(redactShapes(`key=${prefix}IOSFODNN7EXAMPLE`)).toBe(`key=${R}`);
  });

  it('does not redact an AWS-like id with an out-of-set prefix', () => {
    expect(redactShapes('AXYZIOSFODNN7EXAMPLE')).toBe('AXYZIOSFODNN7EXAMPLE');
  });

  // Each Stripe prefix alternative (sk/pk/rk) with _live_ must redact.
  it.each(['sk', 'pk', 'rk'])('redacts a Stripe %s_live_ key', (prefix) => {
    expect(redactShapes(`${prefix}_live_abc123XYZ`)).toBe(R);
  });

  it('redacts a Stripe webhook signing secret', () => {
    expect(redactShapes('whsec_abc123')).toBe(R);
  });

  it('does not redact Stripe test keys (only _live_)', () => {
    expect(redactShapes('sk_test_abc123')).toBe('sk_test_abc123');
  });

  it('does not redact a key with an out-of-set Stripe prefix', () => {
    expect(redactShapes('ak_live_abc123')).toBe('ak_live_abc123');
  });

  // Each GitHub prefix letter [posu] with a >=36-char body must redact; an out-of-set letter must not.
  it.each(['ghp', 'gho', 'ghu', 'ghs'])('redacts a %s_ GitHub token (36 chars)', (prefix) => {
    expect(redactShapes(`${prefix}_${'a'.repeat(36)}`)).toBe(R);
  });

  it('redacts a GitHub token longer than 36 chars in full (no exact-length cap)', () => {
    expect(redactShapes(`ghp_${'a'.repeat(40)}`)).toBe(R);
  });

  it('does not redact a 35-char GitHub-like token (36-char lower bound)', () => {
    expect(redactShapes(`ghp_${'a'.repeat(35)}`)).toBe(`ghp_${'a'.repeat(35)}`);
  });

  it('does not redact a GitHub-like token with an out-of-set prefix letter', () => {
    expect(redactShapes(`ghx_${'a'.repeat(36)}`)).toBe(`ghx_${'a'.repeat(36)}`);
  });

  it('leaves ordinary text untouched', () => {
    expect(redactShapes('hello world 12345')).toBe('hello world 12345');
  });

  it('redacts multiple tokens in one string', () => {
    expect(redactShapes(`a sk_live_x and ghp_${'b'.repeat(36)}`)).toBe(`a ${R} and ${R}`);
  });

  describe('credit cards (opt-in)', () => {
    it('does not redact CC numbers by default', () => {
      expect(redactShapes('5555555555554444')).toBe('5555555555554444');
    });

    it('redacts a Luhn-valid CC number when enabled', () => {
      expect(redactShapes('5555555555554444', { creditCards: true })).toBe(R);
    });

    it('redacts another Luhn-valid CC (valid under doubling, invalid under tripling)', () => {
      expect(redactShapes('4111111111111111', { creditCards: true })).toBe(R);
    });

    it('redacts a separator-formatted Luhn-valid CC when enabled', () => {
      expect(redactShapes('5555-5555-5555-4444', { creditCards: true })).toBe(R);
    });

    it('leaves a Luhn-invalid number when enabled', () => {
      expect(redactShapes('5555555555554445', { creditCards: true })).toBe('5555555555554445');
    });

    // Length bounds: the digit run must be 12-19 digits (all-zero runs are Luhn-valid at any length).
    it('redacts a 12-digit Luhn-valid run (lower length bound)', () => {
      expect(redactShapes('0'.repeat(12), { creditCards: true })).toBe(R);
    });

    it('redacts a 19-digit Luhn-valid run (upper length bound)', () => {
      expect(redactShapes('0'.repeat(19), { creditCards: true })).toBe(R);
    });

    it('does not redact an 11-digit run (below the 12-digit minimum)', () => {
      expect(redactShapes('0'.repeat(11), { creditCards: true })).toBe('0'.repeat(11));
    });

    it('does not redact a 20-digit run (above the 19-digit maximum)', () => {
      expect(redactShapes('0'.repeat(20), { creditCards: true })).toBe('0'.repeat(20));
    });

    it('does not consume a separator trailing the card number', () => {
      expect(redactShapes('card 4111-1111-1111-1111 end', { creditCards: true })).toBe(
        `card ${R} end`,
      );
    });
  });
});

describe('the length bound is scoped to the JWT pattern alone', () => {
  const big = (secret: string) => `${'x'.repeat(40_000)} ${secret}`;

  it('still redacts non-JWT shapes in a very large value', () => {
    // Bounding the whole set threw away real coverage to contain one regex: 7 of 7 probed >32 KB secrets
    // stopped being redacted, AWS keys and Stripe tokens among them.
    expect(redactShapes(big('AKIAIOSFODNN7EXAMPLE'))).toContain('<redacted>');
    expect(redactShapes(big('sk_live_abc123'))).toContain('<redacted>');
    expect(redactShapes(big(`ghp_${'a'.repeat(36)}`))).toContain('<redacted>');
    expect(redactShapes(big('whsec_abc123'))).toContain('<redacted>');
  });

  it('skips only the JWT scan above the bound, and stays fast', () => {
    const hostile = 'eyJ'.repeat(30_000); // ~90 KB, the shape that backtracks
    const started = Date.now();
    expect(() => redactShapes(hostile)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('still redacts a JWT below the bound', () => {
    expect(redactShapes('t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toBe('t <redacted>');
  });
});

describe('the JWT scan is linear, so size no longer costs coverage', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N';

  it('redacts a JWT in a value far above the bound', () => {
    // THE REGRESSION THIS FIXES. The bound was moved from `sanitizeUrl` into this function, where it
    // silently came to gate `sanitizeBody`/`sanitizeJson`/`sanitizeHeaders`/`sanitizeParams` too — all of
    // which called `redactShapes` UNBOUNDED before. Bodies capture at 20480 bytes by default, so every JWT
    // in an 8193–20480 byte body shipped in the clear.
    expect(redactShapes(`${'x'.repeat(40_000)} ${jwt}`)).toContain(R);
    expect(redactShapes(`{"a":"${'y'.repeat(20_000)}","jwt":"${jwt}"}`)).toContain(R);
  });

  it('redacts EVERY JWT in a value, not just the first', () => {
    // `/g` became load-bearing on a brand-new line when the pattern was lifted out of SHAPE_PATTERNS into
    // its own `.replace()`. Every other JWT test uses exactly one JWT, so dropping the flag was invisible.
    const two = `a=${jwt}&b=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyIn0.sigB`;
    expect(redactShapes(two)).toBe(`a=${R}&b=${R}`);
  });

  it('redacts every JWT ABOVE the bound too, where only the anchored pass runs', () => {
    // Below the bound the two passes mask each other: dropping `/g` from the anchored pattern still passed
    // every test, because the unanchored pass caught the second JWT with its own `/g`. Only above the bound
    // is the anchored pattern's `/g` observable on its own.
    const pad = 'x'.repeat(9000);
    expect(redactShapes(`${pad} ${jwt} mid ${jwt}`)).toBe(`${pad} ${R} mid ${R}`);
  });

  it('does not treat `_` or `-` as a token boundary before `eyJ`', () => {
    // They are IN the base64url class, so admitting them as leading delimiters puts a candidate start at
    // every `_eyJ` and restores the quadratic blow-up the anchor exists to remove: 1915 ms at 128 KB.
    const hostile = '_eyJ'.repeat(32_768); // 128 KB
    const started = Date.now();
    redactShapes(hostile);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('stays fast on a huge hostile value — the pattern cannot backtrack', () => {
    // 512 KB of `eyJ` cost 41.9 SECONDS before the pattern was anchored. Anchoring removes the overlapping
    // start positions. (An earlier draft of this line also credited an atomic-group emulation
    // `(?=(x+))\1` — which the SAME commit had already deleted as provably redundant. The comment
    // outlived the code it described by one file.)
    const hostile = 'eyJ'.repeat(170_000); // ~512 KB
    const started = Date.now();
    redactShapes(hostile);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('still matches a JWT glued mid-identifier, below the bound', () => {
    // This is the ONLY class the anchored pattern gives up, and the bounded superset pass is what keeps it.
    // Without a test here that pass is untested weight and would be deleted as dead code.
    expect(redactShapes(`sometoken_${jwt}`)).toBe(`sometoken_${R}`);
    expect(redactShapes(`XXX${jwt}`)).toBe(`XXX${R}`);
  });

  it('matches a JWT after a PERCENT-ENCODED delimiter, at any size', () => {
    // THE GAP THIS CLOSES. Every percent-escape ends in a hex character, and every hex character is inside
    // `[A-Za-z0-9_-]` — so `%3D`, `%20`, `%2F`, `%3A` all looked like token characters and the anchor
    // rejected them. Only the BOUNDED superset pass caught those, which made the bound a COVERAGE gate
    // (the comment claimed it was cost-only) and left the 8193–20480 window open for exactly the shape a
    // JWT usually arrives in: `id_token%3DeyJ…`, the OAuth implicit-flow redirect.
    for (const enc of ['%3D', '%20', '%2F', '%3A', '%22', '%26']) {
      const small = `redirect_uri=%2Fcb%3Fid_token${enc}${jwt}`;
      expect(redactShapes(small), `${enc} small`).not.toContain(jwt);
      const large = `${'x'.repeat(20_000)}\nredirect_uri=%2Fcb%3Fid_token${enc}${jwt}`;
      expect(redactShapes(large), `${enc} above the bound`).not.toContain(jwt);
    }
  });

  it('does not read a hex-looking run that is not an escape as a delimiter', () => {
    // `FFeyJ…` must stay mid-identifier (superset pass only); `%ZZ` and a truncated `%3` are not escapes.
    const pad = 'x'.repeat(20_000);
    expect(redactShapes(`${pad} abc%ZZ${jwt}`)).toContain(jwt);
    expect(redactShapes(`${pad} x%3${jwt}`)).toContain(jwt);
  });

  it('redacts EVERY mid-identifier JWT, not just the first', () => {
    // The superset pass's own `/g` was untested: below the bound the anchored pass consumes every
    // delimiter-preceded JWT first, so the superset pass only ever sees mid-identifier ones — and every
    // test that reached it placed exactly one. Dropping its `/g` leaked the second silently.
    const second = jwt.replace('IjEi', 'IjJi');
    expect(redactShapes(`a_${jwt} b_${second}`)).toBe(`a_${R} b_${R}`);
  });

  it('runs the superset pass AT the bound, not just below it', () => {
    // The bound's inclusivity was unpinned: `<=` vs `<` differed only at exactly 8192 bytes, a one-byte
    // window no test covered.
    const tail = `_${jwt}`; // mid-identifier, so ONLY the superset pass can catch it
    const atBound = 'x'.repeat(8192 - tail.length) + tail;
    expect(atBound).toHaveLength(8192);
    expect(redactShapes(atBound)).toContain(R);
  });

  it('still matches a JWT after every delimiter a real payload uses', () => {
    for (const lead of ['', ' ', 'Bearer ', '"', ':', '=', '/', ',', '\n', '{"t":"', '?tok=']) {
      expect(redactShapes(`${lead}${jwt}`)).toBe(`${lead}${R}`);
    }
  });
});

describe('the JWT bound sits at 8 KB, where the reachable window is', () => {
  it('does not run the unanchored superset pass above 8 KB', () => {
    // Pins the bound from ABOVE. Without this, `MAX_UNANCHORED_SCAN = 16_384` passed all 302 tests — the
    // two existing tests only bracket it to [8042, 16499], a 2× window costing 43–53 ms/request. 8.4 KB is
    // just above the intended bound: cheap at 8192, ~13 ms at any larger value.
    // Asserted as a RATIO, not a wall-clock budget. The 5 ms form measured 0–1 ms clean and 12–13 ms
    // broken: 5× headroom below and only 2.4× above, so a CI runner ~2.5× slower than a dev machine puts
    // the clean and broken bands on top of each other and the test starts flaking. A ratio has no such
    // scale dependence — the quadratic pass costs ~1000× the linear one whatever the hardware.
    const above = 'eyJ'.repeat(2_800); // 8400 bytes — just above the bound
    const below = 'eyJ'.repeat(2_600); // 7800 bytes — just below it, so the superset pass DOES run
    // `Date.now()`, not `performance.now()` — this package compiles without the DOM or Node libs, so
    // `performance` is not a declared global here. 5 iterations puts the slow side at ~60 ms, well clear
    // of the 1 ms resolution.
    const time = (value: string): number => {
      const started = Date.now();
      for (let i = 0; i < 5; i += 1) {
        redactShapes(value);
      }
      return Date.now() - started;
    };
    time(above); // warm up, so JIT state is not attributed to the measurement
    time(below);
    // Same input size to within 8%, so any difference is the skipped pass rather than the length. The
    // `+ 1` keeps the comparison meaningful when the fast side rounds to 0 ms.
    expect(time(above) + 1).toBeLessThan(time(below) / 10);
  });

  it('is fast in the 8–32 KB window Node’s default header size lands in', () => {
    // Moving the bound into this function silently raised it from 8192 to 32768, widening the reachable
    // DoS window 4×: a 16 KB `eyJ`-dense URL cost 38 ms of synchronous app-thread CPU, and Node's default
    // maxHeaderSize is 16384 — reachable by default via server-instrument on every inbound request.
    //
    // A RATIO, for the same reason the test above is one — and this test is why that reason is worth
    // repeating: it was left in the `toBeLessThan(5)` wall-clock form when its neighbour was converted,
    // and it duly failed on the self-hosted CI runner at 11 ms for healthy code. Machine speed divides
    // out of a ratio; it does not divide out of a millisecond budget.
    const hostile = 'eyJ'.repeat(5_500); // ~16.5 KB — above the bound, so the superset pass is skipped
    const processed = 'eyJ'.repeat(2_600); // 7.8 KB — below it, so the pass DOES run
    const time = (value: string): number => {
      const started = Date.now();
      for (let i = 0; i < 5; i += 1) {
        redactShapes(value);
      }
      return Date.now() - started;
    };
    time(hostile); // warm up
    time(processed);
    // The hostile input is more than TWICE the length of the one that is actually processed, so this
    // is a conservative comparison: were it not being skipped, it would cost far more, not less.
    expect(time(hostile) + 1).toBeLessThan(time(processed) / 10);
  });

  it('still redacts a JWT just under the bound', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
    expect(redactShapes(`${'x'.repeat(8000)} ${jwt}`)).toContain('<redacted>');
  });
});

// One COMPLETE secret per shape redactShapes knows. Built from pieces where it resembles a live key, so the
// repository's secret scanning does not take a fixture for a real one.
const SAMPLES: Record<string, string> = {
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
  'aws AKIA': 'AKIAIOSFODNN7EXAMPLE',
  'aws ASIA': 'ASIAIOSFODNN7EXAMPLE',
  'aws AGPA': 'AGPAIOSFODNN7EXAMPLE',
  'aws AIDA': 'AIDAIOSFODNN7EXAMPLE',
  'aws AROA': 'AROAIOSFODNN7EXAMPLE',
  'stripe sk': ['sk', 'live', 'abcdefghijklmnop'].join('_'),
  'stripe pk': ['pk', 'live', 'abcdefghijklmnop'].join('_'),
  'stripe rk': ['rk', 'live', 'abcdefghijklmnop'].join('_'),
  'stripe webhook': ['whsec', 'abcdefghijklmnop'].join('_'),
  'github ghp': `ghp_${'a'.repeat(36)}`,
  'github gho': `gho_${'a'.repeat(36)}`,
  'github ghu': `ghu_${'a'.repeat(36)}`,
  'github ghs': `ghs_${'a'.repeat(36)}`,
};

describe('unfinishedSecretStart', () => {
  const b64url = (text: string): string =>
    (globalThis as unknown as { btoa(input: string): string })
      .btoa(text)
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  /** A JWT whose PAYLOAD contains a second `eyJ` (base64url of a nested `{"` on a 3-byte boundary). */
  const nestedJwt = (): { jwt: string; header: string; payload: string } => {
    for (let pad = 0; pad < 8; pad += 1) {
      const payload = b64url(
        `${' '.repeat(pad)}{"exp":1,"realm_access":{"roles":["admin"]},"email":"alice@corp.example"}`,
      );
      if (payload.indexOf('eyJ', 3) > 0) {
        const header = 'eyJhbGciOiJIUzI1NiJ9';
        return { jwt: `${header}.${payload}.c2lnbmF0dXJl`, header, payload };
      }
    }
    throw new Error('no nested-eyJ payload found');
  };

  it('is -1 when nothing secret-shaped begins, or when the text is empty', () => {
    expect(unfinishedSecretStart('nothing secret here, just words and AKI')).toBe(-1);
    expect(unfinishedSecretStart('')).toBe(-1);
  });

  it('is -1 for a complete secret of every shape (redactShapes will handle it whole)', () => {
    for (const secret of Object.values(SAMPLES)) {
      expect(redactShapes(secret)).not.toBe(secret);
      expect(unfinishedSecretStart(`id_token=${secret}`)).toBe(-1);
    }
  });

  it('points at the start of a secret the text ENDS inside: AWS (needs all 20), GitHub (needs 36)', () => {
    expect(unfinishedSecretStart(`k=${'AKIAIOSFODNN7EXAMPLE'.slice(0, 14)}`)).toBe(2);
    expect(unfinishedSecretStart(`k=${`ghp_${'a'.repeat(15)}`}`)).toBe(2);
  });

  it('treats a Stripe/webhook key as finished at any length (the pattern matches a partial one)', () => {
    expect(unfinishedSecretStart(`k=${SAMPLES['stripe sk']?.slice(0, 10)}`)).toBe(-1);
    expect(unfinishedSecretStart(`k=${SAMPLES['stripe webhook']?.slice(0, 8)}`)).toBe(-1);
  });

  it('handles a JWT whose payload contains a second eyJ: back off to the HEADER, not the inner start', () => {
    const { jwt, header, payload } = nestedJwt();
    const innerAt = header.length + 1 + payload.indexOf('eyJ', 3);
    expect(innerAt).toBeGreaterThan(header.length + 1);
    // cut inside the payload, after the nested start
    const cutInPayload = jwt.slice(0, innerAt + 10);
    expect(unfinishedSecretStart(cutInPayload)).toBe(0);
    expect(unfinishedSecretStart(`id_token=${cutInPayload}`)).toBe(9);
    // cut inside the signature: a complete (3-segment) JWT, so nothing to back off from
    expect(unfinishedSecretStart(jwt.slice(0, jwt.length - 4))).toBe(-1);
  });

  it('does not cut a complete secret in half because another shape begins inside it', () => {
    // AKIA + 16 characters is a complete key even though `ASIA` appears inside its tail.
    expect(unfinishedSecretStart('AKIAXXXXASIAYYYYYYYY')).toBe(-1);
    // the same text one character short is unfinished, and the OUTER start is the answer
    expect(unfinishedSecretStart('k=AKIAXXXXASIAYYYYYYY')).toBe(2);
    // a ghp_ token that is complete with an AKIA-looking run inside it
    expect(unfinishedSecretStart(`x=ghp_abcdefghijAKIAqrstuvwxyz0123456789ab`)).toBe(-1);
    expect(unfinishedSecretStart('x=ghp_abcdefghijAKIAqrstuvwxyz012345')).toBe(2);
  });

  it('finds the unfinished one after several complete, independent secrets', () => {
    const text = `${SAMPLES['github ghp']}/${SAMPLES['aws AKIA']}/${SAMPLES.jwt}/AKIAIOSFOD`;
    expect(unfinishedSecretStart(text)).toBe(text.length - 'AKIAIOSFOD'.length);
    expect(unfinishedSecretStart(text.slice(0, text.length - 'AKIAIOSFOD'.length))).toBe(-1);
  });

  it('does not take a COMPLETE secret that sits inside an unfinished JWT payload for the JWT being complete', () => {
    // `id_token=<header>.<payload>` cut inside the payload, with an AWS key embedded in that payload. The AWS
    // key is complete, but the JWT is not (two segments): the cut must still back off to the header.
    const text = `id_token=eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEs${'x'.repeat(20)}${SAMPLES['aws AKIA']}${'y'.repeat(30)}`;
    expect(redactShapes(text)).toContain('eyJhbGciOiJIUzI1NiJ9'); // not matched as a JWT: only two segments
    expect(unfinishedSecretStart(text)).toBe(9);
  });

  // The cap on starts examined: a JWT whose payload holds N inner `eyJ` starts, then a signature, then a
  // half-written AWS key. Within the cap the walk sees the JWT finish and answers with the AWS key's start; past
  // it the walk gives up and answers with the (earlier) current candidate. Pins 16 exactly.
  const withInnerStarts = (inner: number): { text: string; awsAt: number } => {
    const jwt = `eyJh.${'eyJ'.repeat(inner)}.sig`;
    return { text: `${jwt}/AKIAxx`, awsAt: jwt.length + 1 };
  };

  it('examines the first start plus 16 more: 15 inner starts still reach the AWS key (check 16 is allowed)', () => {
    const { text, awsAt } = withInnerStarts(15);
    expect(unfinishedSecretStart(text)).toBe(awsAt);
  });

  it('gives up at the 17th check and answers with the current candidate (16 inner starts)', () => {
    const { text } = withInnerStarts(16);
    expect(unfinishedSecretStart(text)).toBe(0);
    expect(unfinishedSecretStart(withInnerStarts(1000).text)).toBe(0);
  });

  it('known limitation, pinned: a Stripe/GitHub token glued to another token start swallows its prefix', () => {
    // `sk_live_` matches any alnum run, so it "completes" by swallowing `gho` of the glued `gho_<30>`, and the
    // rest of the inner token is not seen as unfinished. The same glue already survives redactShapes on main
    // without any cut, so this is not new exposure.
    const glued = `k=sk_live_gho_${'a'.repeat(30)}`;
    expect(unfinishedSecretStart(glued)).toBe(-1);
    expect(redactShapes(`sk_live_ghp_${'a'.repeat(36)}`)).toContain(`_${'a'.repeat(36)}`);
  });

  it('stays bounded and safe on text dense with starts: past the candidate limit it backs off to the current one', () => {
    const dense = `x=${'eyJ'.repeat(5000)}`;
    const started = Date.now();
    expect(unfinishedSecretStart(dense)).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('compileShapePattern', () => {
  it('groups the start, so an alternation at its top level cannot swallow the rest of the pattern', () => {
    const pattern = compileShapePattern('foo|bar', '[0-9]{3}');
    expect('foo123 bar456 foo bar'.match(pattern)).toEqual(['foo123', 'bar456']);
  });
});
