import { getCarrierClient, setCarrierClient } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { launch } from './launch';

const BAD: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['an empty string', ''],
  ['a whitespace-only string', '  \t\n'],
  ['null', null],
  ['a number', 42],
  ['an object', {}],
];

describe('@bugsee/bun launch() with a missing app token', () => {
  it.each(
    BAD,
  )('does not throw for %s; reports once and returns a disabled client', async (_label, token) => {
    const carrier = {};
    const onError = vi.fn();
    const client = launch(token as string, { carrier, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/app token is missing/);
    expect(client.isLaunched()).toBe(false);
    expect(getCarrierClient(carrier)).toBeUndefined();
    expect(() => client.setAttribute('k', 'v')).not.toThrow();
    await client.stop();
  });

  it('falls back to console.warn when no onError is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = launch(undefined as unknown as string, { carrier: {} });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(client.isLaunched()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('defers to a live client: a bad token returns it with the repeat-launch error', async () => {
    const carrier = {};
    const live = { isLaunched: () => true } as never;
    setCarrierClient(live, carrier);
    const onError = vi.fn();
    const client = launch(undefined as unknown as string, { carrier, onError });
    expect(client).toBe(live);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/more than once/);
  });
});
