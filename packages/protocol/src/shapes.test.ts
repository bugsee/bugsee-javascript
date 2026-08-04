import { describe, expect, it } from 'vitest';
import { redactShapes } from './index';

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
