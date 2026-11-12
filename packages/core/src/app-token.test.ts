import { describe, expect, it, vi } from 'vitest';
import { createDisabledClientForMissingToken, isValidAppToken } from './app-token';
import { getCarrierClient, setCarrierClient } from './carrier';

describe('isValidAppToken', () => {
  it('accepts a non-empty string', () => {
    expect(isValidAppToken('abc')).toBe(true);
    expect(isValidAppToken(' a ')).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', ' \t\n '],
    ['number', 42],
    ['object', {}],
    ['boolean', true],
  ])('rejects %s', (_name, value) => {
    expect(isValidAppToken(value)).toBe(false);
  });
});

describe('createDisabledClientForMissingToken', () => {
  it('returns undefined and reports nothing for a valid token', () => {
    const onError = vi.fn();
    expect(createDisabledClientForMissingToken('tok', { onError })).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('returns an inert client and reports ONE clear error through onError', () => {
    const onError = vi.fn();
    const client = createDisabledClientForMissingToken(undefined, { onError, carrier: {} });
    expect(client).toBeDefined();
    expect(onError).toHaveBeenCalledTimes(1);
    const error = onError.mock.calls[0]?.[0] as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      'Bugsee: the app token is missing (expected a non-empty string, got undefined); the SDK is disabled.',
    );
  });

  it('names the received value kind', () => {
    const onError = vi.fn();
    createDisabledClientForMissingToken(42, { onError });
    expect((onError.mock.calls[0]?.[0] as Error).message).toContain('got number');
    createDisabledClientForMissingToken('  ', { onError });
    expect((onError.mock.calls[1]?.[0] as Error).message).toContain('got an empty string');
    createDisabledClientForMissingToken(null, { onError });
    expect((onError.mock.calls[2]?.[0] as Error).message).toContain('got null');
  });

  it('falls back to console.warn when no onError is given', () => {
    const warn = vi
      .spyOn((globalThis as unknown as { console: { warn: (m: string) => void } }).console, 'warn')
      .mockImplementation(() => {});
    try {
      createDisabledClientForMissingToken('', {});
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('app token is missing');
    } finally {
      warn.mockRestore();
    }
  });

  it('never throws when the host onError throws', () => {
    expect(() =>
      createDisabledClientForMissingToken(undefined, {
        onError: () => {
          throw new Error('sink');
        },
      }),
    ).not.toThrow();
  });

  it('the client is not launched, claims no carrier slot, and its calls do not throw', async () => {
    const carrier = {};
    const client = createDisabledClientForMissingToken(undefined, { onError: () => {}, carrier });
    if (client === undefined) throw new Error('expected a client');
    client.launch();
    expect(client.isLaunched()).toBe(false);
    expect(getCarrierClient(carrier)).toBeUndefined();
    expect(() => client.setAttribute('k', 'v')).not.toThrow();
    expect(() => client.logException(new Error('x'))).not.toThrow();
    await expect(client.stop()).resolves.toBeDefined();
  });

  it('defers to the live client: a bad token while a client owns the carrier is left to the repeat-launch path', () => {
    const carrier = {};
    setCarrierClient({} as never, carrier);
    const onError = vi.fn();
    expect(createDisabledClientForMissingToken(undefined, { onError, carrier })).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});
