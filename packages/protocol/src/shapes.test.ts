import { describe, expect, it } from 'vitest';
import { redactShapes } from './index';

const R = '<redacted>';

describe('redactShapes', () => {
  it('redacts a JWT embedded in text', () => {
    expect(redactShapes('auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dozjgNryP4J3jVmNHl0w5N')).toBe(
      `auth ${R}`,
    );
  });

  it('redacts an AWS access key id', () => {
    expect(redactShapes('key=AKIAIOSFODNN7EXAMPLE')).toBe(`key=${R}`);
  });

  it('redacts Stripe live keys and webhook secrets', () => {
    expect(redactShapes('sk_live_abc123XYZ')).toBe(R);
    expect(redactShapes('whsec_abc123')).toBe(R);
  });

  it('does not redact Stripe test keys (only _live_)', () => {
    expect(redactShapes('sk_test_abc123')).toBe('sk_test_abc123');
  });

  it('redacts a GitHub PAT', () => {
    expect(redactShapes(`ghp_${'a'.repeat(36)}`)).toBe(R);
  });

  it('does not redact a too-short GitHub-like token', () => {
    expect(redactShapes(`ghp_${'a'.repeat(10)}`)).toBe(`ghp_${'a'.repeat(10)}`);
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
  });
});
