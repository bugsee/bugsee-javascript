import { describe, expect, it, vi } from 'vitest';
import { launch as launchBrowser } from './launch';
import { launch as launchNode } from './node';

describe('umbrella launch() with a missing app token', () => {
  it('node entry: reports once, returns a disabled client that still has the performance facade', async () => {
    const onError = vi.fn();
    const client = launchNode(undefined as unknown as string, { carrier: {}, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/app token is missing/);
    expect(client.isLaunched()).toBe(false);
    expect(typeof client.startTransaction).toBe('function');
    await client.stop();
  });

  it('browser entry: resolves (does not reject) with a disabled client', async () => {
    const onError = vi.fn();
    const client = await launchBrowser('', { carrier: {}, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(client.isLaunched()).toBe(false);
    await client.stop();
  });
});
