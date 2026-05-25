// Sanitizer denylists + redaction tokens (design §8.10). The tokens are byte-identical to mobile
// so server-side dedup stays consistent. Headers match case-insensitively but EXACTLY; body/query
// keys match case-insensitively by SUBSTRING (privacy-conservative; deliberately catches e.g.
// `userPassword`, `oauth_token`).

export const REDACTED = '<redacted>';
export const REDACTED_URL_ENCODED = '%3Credacted%3E';

/** Header names (lowercased) redacted by exact, case-insensitive match. */
export const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-forwarded-for',
  'x-real-ip',
  'authentication',
  'x-amz-security-token',
  'x-amz-credential',
  'x-amz-signature',
  'x-goog-api-key',
  'x-goog-iam-authorization-token',
  'x-vault-token',
  'x-vault-wrap-ttl',
  'x-forwarded-authorization',
  'x-original-authorization',
  'proxy-cookie',
  'x-shopify-access-token',
  'x-clerk-session-token',
  'x-supabase-auth',
  'x-okapi-token',
  'x-ms-token-aad-access-token',
  'x-ms-token-aad-id-token',
  'x-ms-token-aad-refresh-token',
]);

/** Substrings (lowercased) that mark a body/query key as sensitive (case-insensitive substring). */
export const SENSITIVE_KEY_SUBSTRINGS: readonly string[] = [
  'password',
  'passwd',
  'pass',
  'secret',
  'client_secret',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth_token',
  'api_key',
  'apikey',
  'authorization',
  'credit_card',
  'creditcard',
  'card_number',
  'cardnumber',
  'cvv',
  'cvc',
  'cvv2',
  'ssn',
  'social_security',
  'pin',
  'private_key',
  'privatekey',
  'jwt',
  'bearer',
  'bearer_token',
  'auth',
  'creds',
  'credentials',
  'session_token',
  'sessionid',
  'phpsessid',
  'jsessionid',
  'connect.sid',
  'csrf',
  'csrf_token',
  '_csrf',
  'xsrf_token',
  'code_verifier',
  'client_assertion',
  'signature',
  'hmac',
  'mfa_token',
  'otp',
  'totp',
  'routing_number',
  'account_number',
  'iban',
  'swift',
  'bank_account',
  'dob',
  'date_of_birth',
  'passport',
  'passport_number',
  'national_id',
  'tax_id',
  'ein',
];

/** True if `name` is a sensitive header (case-insensitive exact match). */
export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase());
}

/** True if `name` contains a sensitive substring (case-insensitive). */
export function isSensitiveKey(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_KEY_SUBSTRINGS.some((sub) => lower.includes(sub));
}
