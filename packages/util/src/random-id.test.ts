import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from './random-id';

describe('randomId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns 32 lowercase-hex chars (the global Web Crypto path)', () => {
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('mints a distinct id each call', () => {
    expect(randomId()).not.toBe(randomId());
  });

  it('falls back to a NON-crypto id when the global crypto is absent (Node < 19)', () => {
    vi.stubGlobal('crypto', undefined);
    const id = randomId();
    expect(id).toMatch(/^[0-9a-f]{32}$/); // still a valid id…
    expect(randomId()).not.toBe(id); // …and still distinct per call
  });

  it('falls back when a global crypto exists but lacks randomUUID', () => {
    vi.stubGlobal('crypto', {}); // present but no randomUUID
    expect(randomId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('zero-pads each fallback chunk to a full 32-hex id (a small random value must not shorten it)', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0); // smallest value → '0' per chunk; padStart fills to 8
    expect(randomId()).toBe('0'.repeat(32)); // 4 × 8 zero-padded hex — not '0000'
  });
});
