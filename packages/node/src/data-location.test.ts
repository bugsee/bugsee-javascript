import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DATA_SUBDIR,
  ensureSecureDataRoot,
  hashAppToken,
  resolveDataLocation,
  type SecureDirStat,
} from './data-location';

const TOKEN = 'app-token-xyz';

describe('ensureSecureDataRoot', () => {
  const dirStat = (uid: number, mode: number): SecureDirStat => ({
    isDirectory: () => true,
    uid,
    mode,
  });

  it('passes for a directory we own with 0700 mode — creating the base BEFORE the leaf', () => {
    const made: string[] = [];
    expect(() =>
      ensureSecureDataRoot('/tmp/bugsee/abc', {
        mkdir: (d) => made.push(d),
        lstat: () => dirStat(1000, 0o40700),
        getuid: () => 1000,
      }),
    ).not.toThrow();
    expect(made).toEqual(['/tmp/bugsee', '/tmp/bugsee/abc']); // base verified before the leaf is created
  });

  it('verifies the base BEFORE creating the leaf (a foreign base aborts before the leaf is ever made)', () => {
    const made: string[] = [];
    expect(() =>
      ensureSecureDataRoot('/tmp/bugsee/abc', {
        mkdir: (d) => made.push(d),
        // The base is foreign-owned; the leaf would be fine — so this only throws if the base is verified FIRST.
        lstat: (d) => (d === '/tmp/bugsee' ? dirStat(31337, 0o40700) : dirStat(1000, 0o40700)),
        getuid: () => 1000,
      }),
    ).toThrow(/not owned by this user/);
    expect(made).toEqual(['/tmp/bugsee']); // the leaf was NEVER created — the base is verified before the leaf
  });

  it('throws when the root is foreign-owned (a pre-created attacker dir) → launch degrades to memory', () => {
    expect(() =>
      ensureSecureDataRoot('/tmp/bugsee/abc', {
        mkdir: () => {},
        lstat: () => dirStat(31337, 0o40700), // owned by someone else
        getuid: () => 1000,
      }),
    ).toThrow(/not owned by this user/);
  });

  it('throws when the root is group/other-accessible (unsafe mode)', () => {
    expect(() =>
      ensureSecureDataRoot('/tmp/bugsee/abc', {
        mkdir: () => {},
        lstat: () => dirStat(1000, 0o40777),
        getuid: () => 1000,
      }),
    ).toThrow(/group\/other-accessible/);
  });

  it('throws when the path is a symlink / not a real directory', () => {
    expect(() =>
      ensureSecureDataRoot('/tmp/bugsee/abc', {
        mkdir: () => {},
        lstat: () => ({ isDirectory: () => false, uid: 1000, mode: 0o40700 }),
        getuid: () => 1000,
      }),
    ).toThrow(/not a directory/);
  });

  it('skips the ownership check where there are no uids (Windows: getuid undefined)', () => {
    // A foreign uid is NOT rejected when uids are unavailable; the directory + mode checks still apply.
    expect(() =>
      ensureSecureDataRoot('/tmp/bugsee/abc', {
        mkdir: () => {},
        lstat: () => dirStat(31337, 0o40700),
        getuid: undefined,
      }),
    ).not.toThrow();
  });

  it('rejects an unsafe mode even when uids are unavailable (Windows path)', () => {
    expect(() =>
      ensureSecureDataRoot('/tmp/bugsee/abc', {
        mkdir: () => {},
        lstat: () => dirStat(31337, 0o40750),
        getuid: undefined,
      }),
    ).toThrow(/group\/other-accessible/);
  });

  it('propagates a mkdir failure (a broken/contended tmp) so launch degrades to memory', () => {
    const boom = new Error('EROFS mkdir');
    expect(() =>
      ensureSecureDataRoot('/tmp/bugsee/abc', {
        mkdir: vi.fn(() => {
          throw boom;
        }),
        lstat: () => dirStat(1000, 0o40700),
        getuid: () => 1000,
      }),
    ).toThrow(boom);
  });
});

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

  it('matches a golden vector (freezes BOTH passes’ seed/prime constants against silent drift)', () => {
    // A swapped h2 seed/prime (or h1-constants reused for h2) keeps the halves differing but changes THIS.
    expect(hashAppToken('app-token-xyz')).toBe('263edf727b588036');
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
