import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import type { UploadPipeline } from './transport';

// Review round 3 (H1): R3L-2. The shared stop drain runs UNBOUNDED; each caller's timeout only bounds its own wait.

const getEnvironment = (): EnvironmentEnvelope => ({
  platform: { type: 'web', version: '1' },
  runtime: { type: 'web', version: '' },
  sdk: { version: '0', type: 'javascript' },
});
const noScheduler = { setInterval: () => 'h', clearInterval: () => {} };
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) =>
    (globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }).setTimeout(
      resolve,
      ms,
    ),
  );
const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/** A pipeline whose flush HONOURS the timeout it is given (like the real one), else waits for the gate. */
const honouring = () => {
  let release: (ok: boolean) => void = () => {};
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const timeouts: Array<number | undefined> = [];
  const uploadPipeline: UploadPipeline = {
    enqueue: async () => ({ ok: true }),
    flush: (timeout?: number) => {
      timeouts.push(timeout);
      return timeout === undefined ? gate : Promise.race([gate, sleep(timeout).then(() => false)]);
    },
    drop: vi.fn(),
  };
  const client = createClient({
    uploadPipeline,
    appToken: 'tok',
    getEnvironment,
    scheduler: noScheduler,
  });
  return { client, release: (ok = true) => release(ok), timeouts };
};

describe('R3L-2 — the shared stop drain is not bounded by the first caller', () => {
  it('stop(20) times out, the upload then finishes, and a repeat stop() answers TRUE', async () => {
    const { client, release, timeouts } = honouring();
    client.launch();
    await expect(client.stop(20)).resolves.toBe(false);
    expect(timeouts).toEqual([undefined]); // the real drain was started without the caller's bound
    release(true);
    await tick();
    await expect(client.stop()).resolves.toBe(true);
  });

  it('stop(30) timing out, then stop() waits for the real drain and reports true', async () => {
    const { client, release } = honouring();
    client.launch();
    await expect(client.stop(30)).resolves.toBe(false);
    const again = client.stop();
    let settled = false;
    void again.then(() => {
      settled = true;
    });
    await sleep(40);
    expect(settled).toBe(false);
    release(true);
    await expect(again).resolves.toBe(true);
  });

  it('flush(timeout) still bounds the pipeline flush it starts', async () => {
    const { client, timeouts } = honouring();
    client.launch();
    await client.flush(15);
    expect(timeouts).toEqual([15]);
  });
});
