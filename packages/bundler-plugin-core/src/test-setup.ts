// Test isolation: the plugin reads `.env.bugsee-build-plugin` from the working directory at startup, so a
// developer's real file in this repo (or any parent) would flip every test that expects "no token => disabled".
// Every test therefore sees NO file, except the files that exercise the lookup itself and opt in with
// `globalThis.__BUGSEE_REAL_ENV_FILE__ = true`.
import { vi } from 'vitest';

vi.mock('./env-file', async (importOriginal) => {
  const real = await importOriginal<typeof import('./env-file')>();
  return {
    ...real,
    loadBuildPluginEnv: (...args: Parameters<typeof real.loadBuildPluginEnv>) =>
      (globalThis as { __BUGSEE_REAL_ENV_FILE__?: boolean }).__BUGSEE_REAL_ENV_FILE__
        ? real.loadBuildPluginEnv(...args)
        : { values: {} },
  };
});
