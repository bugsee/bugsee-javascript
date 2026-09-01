import { describe, expect, it } from 'vitest';
import { BugseeError } from './errors';
import { classifyServerErrorCode, isRetryableHttpStatus, isUploadSettled } from './transport';

// The upload-settlement POLICY, tested directly rather than only through its consumers.
//
// Android parity target: `CommunicationErrorClassifier.classifyHttpStatus` (`:14-33`) —
//   401            → AUTH_EXPIRED → SHOULD_RETRY   (`toJobResult`)
//   408 / 425 / 429 → TRANSIENT   → SHOULD_RETRY
//   any other 4xx  → PERMANENT    → FAILURE
//   5xx / anything else → TRANSIENT → SHOULD_RETRY
//
// This is the classifier whose verdict decides, four levels up, whether a crash report's blob,
// its report marker, its capture chunks and its whole instance subtree are DELETED. Every class
// is pinned individually and by exact status, because the defect this replaces (`status >= 500`)
// was invisible to a test that only checked "a 4xx is not retryable".

describe('isRetryableHttpStatus', () => {
  it('treats every 5xx as retryable', () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(isRetryableHttpStatus(status)).toBe(true);
    }
  });

  it('treats an unexpected status at or above 600 as retryable (Android: "anything else")', () => {
    expect(isRetryableHttpStatus(600)).toBe(true);
    expect(isRetryableHttpStatus(999)).toBe(true);
  });

  it('treats a sub-400 status as retryable (Android classifies < 400 as TRANSIENT)', () => {
    // Reached only for a non-2xx: a 3xx on a signed PUT means the request did not complete, so a
    // retry can still succeed. Deleting the report on it would be loss for a redirect.
    for (const status of [0, 100, 300, 302, 399]) {
      expect(isRetryableHttpStatus(status)).toBe(true);
    }
  });

  it('treats 401 as retryable — the session token expired, not the payload refused', () => {
    // Android AUTH_EXPIRED → toJobResult → SHOULD_RETRY. The signed PUT self-auths, so a 401 here is
    // an edge/proxy verdict; the next launch mints a fresh session and a fresh signed url.
    expect(isRetryableHttpStatus(401)).toBe(true);
  });

  it('treats 408, 425 and 429 as retryable', () => {
    // "Without this, a gateway/upstream timeout (408) on a report or bundle upload would be
    // classified PERMANENT and the report dropped." — CommunicationErrorClassifier.java:19-22.
    expect(isRetryableHttpStatus(408)).toBe(true);
    expect(isRetryableHttpStatus(425)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
  });

  it('treats every OTHER 4xx as permanent — the collector refused this payload', () => {
    for (const status of [400, 402, 403, 404, 405, 409, 410, 413, 415, 422, 426, 428, 431, 451]) {
      expect(isRetryableHttpStatus(status)).toBe(false);
    }
  });

  it('pins the 4xx boundaries exactly (399/400 and 499/500)', () => {
    expect(isRetryableHttpStatus(399)).toBe(true);
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(499)).toBe(false);
    expect(isRetryableHttpStatus(500)).toBe(true);
  });

  it('pins the neighbours of each exempted status, so the exemption is a point and not a range', () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(402)).toBe(false);
    expect(isRetryableHttpStatus(407)).toBe(false);
    expect(isRetryableHttpStatus(409)).toBe(false);
    expect(isRetryableHttpStatus(424)).toBe(false);
    expect(isRetryableHttpStatus(426)).toBe(false);
    expect(isRetryableHttpStatus(428)).toBe(false);
    expect(isRetryableHttpStatus(430)).toBe(false);
  });
});

describe('isUploadSettled', () => {
  it('is settled when the upload was delivered', () => {
    expect(isUploadSettled({ ok: true })).toBe(true);
  });

  it('is settled when the collector PERMANENTLY refused the bundle', () => {
    expect(isUploadSettled({ ok: false, permanent: true, error: new BugseeError('no', 400) })).toBe(
      true,
    );
  });

  it('is NOT settled on a retryable failure — that is what the durable queue carries forward', () => {
    expect(isUploadSettled({ ok: false, error: new BugseeError('5xx', 503) })).toBe(false);
    expect(
      isUploadSettled({ ok: false, permanent: false, error: new BugseeError('5xx', 503) }),
    ).toBe(false);
  });

  it('is NOT settled when `permanent` is merely truthy-adjacent (the flag is read strictly)', () => {
    expect(isUploadSettled({ ok: false } as never)).toBe(false);
    expect(isUploadSettled({ ok: false, permanent: undefined } as never)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The COLLECTOR's own error codes — a numeric namespace that is NOT HTTP statuses.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// A `/v2/*` rejection arrives with **HTTP 200** and an `{ ok: false, error: { code } }` envelope, so the
// status never reveals it and the code is the only signal there is. The SDK had no analogue of Android's
// `CommunicationErrorClassifier.classifyServerErrorCode` (`:35-58`) at all, so an InvalidAppToken or an
// ApplicationTypeMismatch — a payload the collector will refuse for the life of the installation — was
// retried at every launch forever, while a code that happens to READ like an auth status (403, 401) was
// misread as one and permanently disabled the SDK.
//
// The two namespaces overlap numerically and mean nothing to each other; that overlap is the finding.

describe('classifyServerErrorCode', () => {
  it('classifies ServerTooBusy as transient — the collector is asking us to come back', () => {
    expect(classifyServerErrorCode(99013)).toBe('transient');
  });

  it('classifies KillSdk as kill_sdk — the ONE code that may disable the SDK', () => {
    // Android blacklists the app token here and ONLY here
    // (`BugseeCommunicationManager.java:776-781`) — never on an HTTP status.
    expect(classifyServerErrorCode(99099)).toBe('kill_sdk');
  });

  it('classifies SessionNotFound as auth_expired — mint a new session and try again', () => {
    expect(classifyServerErrorCode(14002)).toBe('auth_expired');
  });

  it.each([
    [12003, 'SimilarCrashExists'],
    [12004, 'TooManySimilarCrashes'],
    [14019, 'InvalidAppToken'],
    [11004, 'ApplicationTypeMismatch'],
    [99098, 'UnsupportedSdk'],
    [99003, 'MissingParameter'],
    [99002, 'EmptyBody'],
  ])('classifies %i (%s) as permanent', (code) => {
    expect(classifyServerErrorCode(code)).toBe('permanent');
  });

  it('classifies an unknown code as transient (Android’s `default:` arm)', () => {
    // Fail-safe: an unrecognised code must never delete a report. A new collector code the SDK has
    // not learned about yet costs a retry, not an incident.
    for (const code of [0, 1, 42, 12005, 14000, 99000, 123456]) {
      expect(classifyServerErrorCode(code)).toBe('transient');
    }
  });

  it('does NOT read a collector code as an HTTP status — the namespaces are disjoint', () => {
    // 401/403 are AUTH_EXPIRED / PERMANENT as HTTP statuses and mean nothing in the collector's
    // namespace. Reading one as the other is what killed the SDK on a transient rejection.
    expect(classifyServerErrorCode(401)).toBe('transient');
    expect(classifyServerErrorCode(403)).toBe('transient');
    expect(classifyServerErrorCode(500)).toBe('transient');
    expect(isRetryableHttpStatus(403)).toBe(false); // …while the SAME number IS permanent as a status
  });
});
