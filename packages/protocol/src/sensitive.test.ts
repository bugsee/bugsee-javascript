import { describe, expect, it } from 'vitest';
import { isSensitiveHeader, isSensitiveKey, REDACTED, REDACTED_URL_ENCODED } from './index';

describe('redaction tokens', () => {
  it('match the mobile wire contract byte-for-byte', () => {
    expect(REDACTED).toBe('<redacted>');
    expect(REDACTED_URL_ENCODED).toBe('%3Credacted%3E');
  });
});

describe('isSensitiveHeader (case-insensitive exact match)', () => {
  it.each([
    'authorization',
    'Authorization', // case-insensitive
    'Cookie',
    'Set-Cookie',
    'x-api-key',
    'X-Amz-Security-Token',
    'proxy-authorization',
    'x-ms-token-aad-refresh-token',
  ])('flags %s', (name) => {
    expect(isSensitiveHeader(name)).toBe(true);
  });

  it.each([
    'content-type',
    'accept',
    'user-agent',
    'x-authorization-extra', // exact match only — not a substring match
  ])('does not flag %s', (name) => {
    expect(isSensitiveHeader(name)).toBe(false);
  });
});

describe('isSensitiveKey (case-insensitive substring match)', () => {
  it.each([
    'password',
    'PASSWORD', // case-insensitive
    'userPassword', // substring
    'access_token',
    'refresh_token', // contains "token"
    'api_key',
    'ssn',
    'creditCard', // -> creditcard
    'csrf',
    'bearer',
  ])('flags %s', (name) => {
    expect(isSensitiveKey(name)).toBe(true);
  });

  it.each(['username', 'email', 'firstName', 'quantity', 'id'])('does not flag %s', (name) => {
    expect(isSensitiveKey(name)).toBe(false);
  });
});
