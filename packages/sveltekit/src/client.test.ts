import { afterEach, describe, expect, it, vi } from 'vitest';

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@bugsee/bugsee', () => ({ launch }));

import { handleErrorWithBugsee, registerClient, reportSvelteError } from './client';

describe('registerClient', () => {
  afterEach(() => launch.mockReset());

  it('launches the browser SDK with the appToken + options, returns the client', async () => {
    const client = { id: 'browser-client' };
    launch.mockReturnValue(client);
    const result = await registerClient('tok', { captureLogs: false });
    expect(launch).toHaveBeenCalledWith('tok', { captureLogs: false });
    expect(result).toBe(client);
  });

  it('defaults options to an empty object', async () => {
    await registerClient('tok');
    expect(launch).toHaveBeenCalledWith('tok', {});
  });
});

describe('@bugsee/svelte re-export (the client error seam)', () => {
  it('re-exports the SvelteKit client handleError + reportSvelteError', () => {
    // The client hooks.client.ts uses handleErrorWithBugsee; assert the surface is re-exported + functional.
    expect(typeof handleErrorWithBugsee).toBe('function');
    expect(typeof reportSvelteError).toBe('function');
    const hook = handleErrorWithBugsee();
    expect(typeof hook).toBe('function');
  });
});
