import { describe, expect, it, vi } from 'vitest';
import { launch } from './launch';
import { createLazyLauncher, resolveConfig } from './launch-config';

describe('cloudflare launch() with a missing app token', () => {
  it('launch() reports once and returns a disabled client', async () => {
    const carrier = {};
    const onError = vi.fn();
    const client = launch(undefined as unknown as string, { carrier, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/app token is missing/);
    expect(client.isLaunched()).toBe(false);
    await client.stop();
  });

  it.each([
    ['a callback returning undefined (unset secret)', () => (_env: unknown) => undefined],
    ['a static undefined', () => undefined],
    ['a static null', () => null],
  ])('resolveConfig does not throw for %s', (_label, make) => {
    const config = make() as never;
    expect(() => resolveConfig(config, {})).not.toThrow();
    expect(resolveConfig(config, {}).options).toEqual({});
    expect(resolveConfig(config, {}).appToken ?? undefined).toBeUndefined();
  });

  it('resolveConfig still splits an options object and a string token', () => {
    expect(resolveConfig('tok', {})).toEqual({ appToken: 'tok', options: {} });
    expect(resolveConfig({ appToken: 'tok', endpoint: 'e' }, {})).toEqual({
      appToken: 'tok',
      options: { endpoint: 'e' },
    });
  });

  it('the lazy launcher does not throw for an unset secret and caches the disabled client', () => {
    const launcher = createLazyLauncher(((_env: unknown) => undefined) as never);
    const first = launcher({});
    expect(first.isLaunched()).toBe(false);
    expect(launcher({})).toBe(first);
  });
});
