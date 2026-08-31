import { describe, expect, it } from 'vitest';
import { BugseeError } from './errors';
import { isRetryableHttpStatus, isUploadSettled } from './transport';

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
