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
    'x-authorization-extra', // trailing-edge: exact match only, not a substring match
    'extra-authorization', // leading-edge: likewise not matched
  ])('does not flag %s', (name) => {
    expect(isSensitiveHeader(name)).toBe(false);
  });
});

describe('isSensitiveKey (case-insensitive substring match)', () => {
  it.each([
    'PASSWORD', // case-insensitive
    'userPassword', // substring
    'access_token', // contains "token"
    'creditCard', // -> creditcard
  ])('flags %s', (name) => {
    expect(isSensitiveKey(name)).toBe(true);
  });

  // Every independently-matched denylist entry (one whose match is not subsumed by a shorter entry)
  // is pinned here: deleting it from SENSITIVE_KEY_SUBSTRINGS would flip this assertion. Subsumed
  // superstrings (e.g. `password`/`access_token`, retained to mirror the mobile contract) are
  // covered transitively by their shorter substring (`pass`/`token`).
  it.each([
    'pass',
    'secret',
    'token',
    'api_key',
    'apikey',
    'credit_card',
    'creditcard',
    'card_number',
    'cardnumber',
    'cvv',
    'cvc',
    'ssn',
    'social_security',
    'pin',
    'private_key',
    'privatekey',
    'jwt',
    'bearer',
    'auth',
    'creds',
    'credentials',
    'sessionid',
    'phpsessid',
    'connect.sid',
    'csrf',
    'code_verifier',
    'client_assertion',
    'signature',
    'hmac',
    'otp',
    'routing_number',
    'account_number',
    'iban',
    'swift',
    'bank_account',
    'dob',
    'date_of_birth',
    'national_id',
    'tax_id',
    'ein',
  ])('flags the denylisted key %s', (name) => {
    expect(isSensitiveKey(name)).toBe(true);
  });

  it.each(['username', 'email', 'firstName', 'quantity', 'id'])('does not flag %s', (name) => {
    expect(isSensitiveKey(name)).toBe(false);
  });
});
