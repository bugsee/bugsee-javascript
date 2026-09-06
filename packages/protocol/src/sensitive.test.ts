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

  // A header-shaped key inside a JSON BODY. This is how a proxied request, a webhook payload or a
  // captured config object carries one, and the denylist only had the underscore spellings — `api_key`
  // and `apikey`, never `api-key` — so the separator alone was deciding whether a live credential
  // shipped. Matching is now separator-insensitive rather than gaining a hyphenated twin for all 59
  // entries, which is a list that would drift.
  it.each([
    'x-api-key',
    'api-key',
    'X-API-KEY',
    'x-goog-api-key',
    'access-token',
    'refresh-token',
    'client-secret',
    'private-key',
    'auth-token',
    'card-number',
    'x-auth-token',
  ])('flags the hyphenated spelling %s', (name) => {
    expect(isSensitiveKey(name)).toBe(true);
  });

  it.each([
    'api.key',
    'api key',
    'API_Key',
    'x_api_key',
  ])('flags %s — the separator is never what decides', (name) => {
    expect(isSensitiveKey(name)).toBe(true);
  });

  // Normalisation may remove SEPARATORS and nothing else. Stripping any letter would still pass every
  // test above — both the key and the denylist entry are normalised the same way, so `api_key` and
  // `x-api-key` keep matching — while quietly collapsing distinct words together: drop `a` and `auth`
  // becomes `uth`, which `south` contains. A mutation doing exactly that survived until these existed.
  it.each([
    'south',
    'mouth',
    'youth',
  ])('does not flag %s — normalisation removes separators, never letters', (name) => {
    expect(isSensitiveKey(name)).toBe(false);
  });

  // Exact header names with no substring twin. `cookie` is deliberately NOT a substring entry: as one
  // it would flag `cookieConsent` and `cookie_banner_shown`, which are ordinary analytics keys. The
  // header list matches exactly, so consulting it costs no false positives.
  it.each([
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'x-vault-token',
    'x-real-ip',
  ])('flags the exact header name %s when it appears as a body key', (name) => {
    expect(isSensitiveKey(name)).toBe(true);
  });

  it.each([
    'cookieConsent',
    'cookie_banner_shown',
    'cookies_accepted',
  ])('does not flag %s — an exact header name is not a substring rule', (name) => {
    expect(isSensitiveKey(name)).toBe(false);
  });
});
