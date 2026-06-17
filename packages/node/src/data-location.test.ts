import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DATA_SUBDIR, hashAppToken, resolveDataLocation } from './data-location';

const TOKEN = 'app-token-xyz';

describe('hashAppToken', () => {
  it('is deterministic, 16 hex chars, and distinguishes different tokens (namespacing)', () => {
    expect(hashAppToken(TOKEN)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashAppToken(TOKEN)).toBe(hashAppToken(TOKEN)); // stable
    expect(hashAppToken('a')).not.toBe(hashAppToken('b')); // separates apps
    expect(hashAppToken('')).toMatch(/^[0-9a-f]{16}$/); // empty token still hashes
  });

  it('uses BOTH FNV passes — the two 8-char halves carry independent entropy (not h1 duplicated)', () => {
    // Pins the second pass (h2): a mutation collapsing the output to h1+h1 would make the halves equal.
    const h = hashAppToken(TOKEN);
    expect(h.slice(0, 8)).not.toBe(h.slice(8));
  });
});

describe('resolveDataLocation', () => {
  it('defaults to disk capture under <tmpBase>/bugsee/<hashAppToken> when neither flag is set (opt-out)', () => {
    expect(resolveDataLocation({}, '/tmp', TOKEN)).toEqual({
      dataDir: join('/tmp', DEFAULT_DATA_SUBDIR, hashAppToken(TOKEN)),
      diskCapture: true,
    });
  });

  it("capturedDataStore: 'disk' (explicit) also resolves the per-app-token tmp default + disk capture", () => {
    expect(resolveDataLocation({ capturedDataStore: 'disk' }, '/tmp', TOKEN)).toEqual({
      dataDir: join('/tmp', DEFAULT_DATA_SUBDIR, hashAppToken(TOKEN)),
      diskCapture: true,
    });
  });

  it("capturedDataStore: 'memory' opts fully out — no dataDir, no disk capture", () => {
    expect(resolveDataLocation({ capturedDataStore: 'memory' }, '/tmp', TOKEN)).toEqual({
      dataDir: undefined,
      diskCapture: false,
    });
  });

  it('an explicit dataDir overrides the tmp default verbatim (no app-token segment appended)', () => {
    expect(resolveDataLocation({ dataDir: '/var/data' }, '/tmp', TOKEN)).toEqual({
      dataDir: '/var/data',
      diskCapture: true,
    });
  });

  it("dataDir + capturedDataStore: 'memory' keeps the location (durable bundles) but capture stays in-memory", () => {
    // The odd-but-valid combo: persist bundles/markers under dataDir, but keep the rolling capture buffer
    // in RAM. The explicit memory choice wins for capture; the location still locates durable storage.
    expect(
      resolveDataLocation({ dataDir: '/var/data', capturedDataStore: 'memory' }, '/tmp', TOKEN),
    ).toEqual({ dataDir: '/var/data', diskCapture: false });
  });

  it('namespaces the default root by the app token (two tokens → two distinct roots)', () => {
    const a = resolveDataLocation({}, '/tmp', 'token-a').dataDir;
    const b = resolveDataLocation({}, '/tmp', 'token-b').dataDir;
    expect(a).toBe(join('/tmp', DEFAULT_DATA_SUBDIR, hashAppToken('token-a')));
    expect(a).not.toBe(b);
  });

  it('uses the provided tmpBase verbatim for the default root', () => {
    expect(resolveDataLocation({}, '/custom/tmp', TOKEN).dataDir).toBe(
      join('/custom/tmp', DEFAULT_DATA_SUBDIR, hashAppToken(TOKEN)),
    );
  });
});
