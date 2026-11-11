import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UnpluginOptions } from 'unplugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_PLUGIN_ENV_FILE } from './env-file';
import type { BugseePluginOptions, ResolvedPluginOptions } from './resolve';

// `.env.bugsee-build-plugin` (#182): option > environment > file, looked up from the BUNDLER's project dir.
const { uploadSpy } = vi.hoisted(() => ({
  uploadSpy: vi.fn(async (_resolved: unknown, _outDir: string, _deps?: unknown) => undefined),
}));
vi.mock('./resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resolve')>()),
  runPluginUpload: uploadSpy,
}));

(globalThis as { __BUGSEE_REAL_ENV_FILE__?: boolean }).__BUGSEE_REAL_ENV_FILE__ = true;

const { bugseeUnpluginFactory } = await import('./plugin');
const makePlugin = (options?: BugseePluginOptions): UnpluginOptions =>
  bugseeUnpluginFactory(options, { framework: 'vite' }) as UnpluginOptions;

type ViteHooks = {
  config: (c: { root?: string }) => unknown;
  writeBundle: (o: { dir: string }) => Promise<void>;
};
const vite = (p: UnpluginOptions) => p.vite as unknown as ViteHooks;
const uploaded = () => uploadSpy.mock.calls[0]?.[0] as ResolvedPluginOptions;

describe('plugin reads .env.bugsee-build-plugin', () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bugsee-plugin-env-'));
    // A cwd with no env file anywhere nearby, so only the project root can supply the token.
    cwd = mkdtempSync(join(tmpdir(), 'bugsee-plugin-cwd-'));
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    vi.stubEnv('BUGSEE_APP_TOKEN', undefined as unknown as string);
    delete process.env.BUGSEE_APP_TOKEN;
    uploadSpy.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('takes the token from the file in the bundler project dir', async () => {
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_TOKEN=file-token\n');
    const plugin = makePlugin();
    vite(plugin).config({ root });
    await vite(plugin).writeBundle({ dir: '/out' });
    expect(uploaded()).toMatchObject({ enabled: true, appToken: 'file-token' });
  });

  it('finds the nearest file above a nested project dir', async () => {
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_TOKEN=outer\n');
    mkdirSync(join(root, '.git'));
    const app = join(root, 'apps', 'web');
    mkdirSync(app, { recursive: true });
    const plugin = makePlugin();
    vite(plugin).config({ root: app });
    await vite(plugin).writeBundle({ dir: '/out' });
    expect(uploaded().appToken).toBe('outer');
  });

  it('falls back to the working directory when the bundler reports no root', async () => {
    writeFileSync(join(cwd, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_TOKEN=cwd-token\n');
    const plugin = makePlugin();
    await vite(plugin).writeBundle({ dir: '/out' });
    expect(uploaded().appToken).toBe('cwd-token');
  });

  it('the plugin option beats the environment, which beats the file', async () => {
    writeFileSync(
      join(root, BUILD_PLUGIN_ENV_FILE),
      'BUGSEE_APP_TOKEN=file\nBUGSEE_ENDPOINT=https://evil.test\n',
    );
    vi.stubEnv('BUGSEE_APP_TOKEN', 'env-token');

    const fromEnv = makePlugin();
    vite(fromEnv).config({ root });
    await vite(fromEnv).writeBundle({ dir: '/out' });
    // The file cannot redirect the upload: BUGSEE_ENDPOINT is never read from it.
    expect(uploaded()).toMatchObject({ appToken: 'env-token', endpoint: undefined });

    uploadSpy.mockClear();
    const fromOption = makePlugin({ appToken: 'option-token' });
    vite(fromOption).config({ root });
    await vite(fromOption).writeBundle({ dir: '/out' });
    expect(uploaded().appToken).toBe('option-token');
  });

  it('never writes into process.env', () => {
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_TOKEN=file-token\n');
    vite(makePlugin()).config({ root });
    expect(process.env.BUGSEE_APP_TOKEN).toBeUndefined();
  });

  it('a missing file leaves the plugin disabled and the build intact', async () => {
    const plugin = makePlugin();
    expect(() => vite(plugin).config({ root })).not.toThrow();
    await vite(plugin).writeBundle({ dir: '/out' });
    expect(uploaded()).toMatchObject({ enabled: false, appToken: '' });
  });

  it('a malformed file never fails the build and yields no token', async () => {
    writeFileSync(
      join(root, BUILD_PLUGIN_ENV_FILE),
      Buffer.from([0xff, 0x00, 0x3d, 0x0a, 0x3d, 0x3d]),
    );
    const plugin = makePlugin();
    expect(() => vite(plugin).config({ root })).not.toThrow();
    await vite(plugin).writeBundle({ dir: '/out' });
    expect(uploaded().enabled).toBe(false);
  });

  it('a file token turns on map emission like any other token', () => {
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_TOKEN=file-token\n');
    const result = vite(makePlugin()).config({ root }) as { build?: { sourcemap?: boolean } };
    expect(result.build?.sourcemap).toBe(true);
  });

  it('a blank token in the environment counts as unset, so the file supplies it', async () => {
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_TOKEN=file-token\n');
    vi.stubEnv('BUGSEE_APP_TOKEN', '  ');
    const plugin = makePlugin();
    vite(plugin).config({ root });
    await vite(plugin).writeBundle({ dir: '/out' });
    expect(uploaded().appToken).toBe('file-token');
  });

  it('a stray file above the repository root gives no token', async () => {
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_TOKEN=stray\n');
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const plugin = makePlugin();
    vite(plugin).config({ root: repo });
    await vite(plugin).writeBundle({ dir: '/out' });
    expect(uploaded().enabled).toBe(false);
  });

  it('says ONCE, without the contents, that a found file held nothing usable', () => {
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_ENDPOINT=https://secret.test\n');
    const notices: string[] = [];
    const plugin = makePlugin({ onNotice: (m) => notices.push(m) });
    vite(plugin).config({ root });
    vite(plugin).config({ root });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('holds no usable');
    expect(notices[0]).not.toContain('secret.test');
  });

  it('says nothing for a good file, a missing file, or a disabled plugin', () => {
    const notices: string[] = [];
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'BUGSEE_APP_TOKEN=t\n');
    vite(makePlugin({ onNotice: (m) => notices.push(m) })).config({ root });
    expect(notices).toEqual([]);
    const empty = mkdtempSync(join(tmpdir(), 'bugsee-plugin-empty-'));
    vite(makePlugin({ onNotice: (m) => notices.push(m) })).config({ root: empty });
    rmSync(empty, { recursive: true, force: true });
    writeFileSync(join(root, BUILD_PLUGIN_ENV_FILE), 'nothing useful\n');
    vite(makePlugin({ disabled: true, onNotice: (m) => notices.push(m) })).config({ root });
    expect(notices).toEqual([]);
  });
});
