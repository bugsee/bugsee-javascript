// SM8 — the source-map plugin e2e. Drives the REAL @bugsee/vite-plugin writeBundle hook against a REAL
// (fake) `bugsee-cli` subprocess and a REAL build-output directory on disk. Proves the whole chain end to
// end — resolve the binary → spawn `sourcemaps inject` → spawn `debug-files upload` → delete client maps —
// exercising the actual child_process spawn + fs the unit tests could only mock. Only the Rust binary is
// faked (a tiny node script that records its argv + token). Also asserts the runtime debug-ID attach.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDebugIds, formatStack, parseV8Stack, type StackFrame } from '@bugsee/core';
import { bugseeVitePlugin } from '@bugsee/vite-plugin';
import { afterEach, describe, expect, it } from 'vitest';

/** Extract the callable writeBundle hook from an unplugin-produced Vite plugin. */
function writeBundleHook(plugin: unknown): (output: { dir: string }) => Promise<void> {
  const one = Array.isArray(plugin) ? plugin[0] : plugin;
  const hook = (one as { writeBundle: unknown }).writeBundle;
  // unplugin may expose the hook as a bare function or as { handler }.
  const fn = typeof hook === 'function' ? hook : (hook as { handler: unknown }).handler;
  return fn as (output: { dir: string }) => Promise<void>;
}

describe('@bugsee source-maps — plugin drives bugsee-cli (e2e, fake binary)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.BUGSEE_CLI_PATH;
  });

  it('at writeBundle: spawns inject → upload with the right argv/token, then deletes the client .map', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bugsee-sm-e2e-'));
    const outDir = join(dir, 'dist');
    mkdirSync(outDir);
    writeFileSync(join(outDir, 'app.js'), 'console.log(1)\n//# sourceMappingURL=app.js.map');
    writeFileSync(join(outDir, 'app.js.map'), '{"version":3,"sources":[],"debugId":"e2e-id"}');

    // A fake `bugsee-cli`: records each invocation's argv + token to a log, exits 0.
    const logPath = join(dir, 'cli.log');
    const cliPath = join(dir, 'fake-bugsee-cli.mjs');
    writeFileSync(
      cliPath,
      `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\n` +
        `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), token: process.env.BUGSEE_APP_TOKEN, endpoint: process.env.BUGSEE_ENDPOINT }) + '\\n');\n`,
    );
    chmodSync(cliPath, 0o755);
    process.env.BUGSEE_CLI_PATH = cliPath;

    const plugin = bugseeVitePlugin({
      appToken: 'e2e-tok',
      appVersion: '1.2.3',
      appBuild: '99',
      endpoint: 'https://api.e2e.test',
    });
    await writeBundleHook(plugin)({ dir: outDir });

    const lines = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; token?: string; endpoint?: string });

    // 1) inject, then 2) upload — in that order, with the resolved version/build.
    expect(lines[0]?.argv).toEqual(['sourcemaps', 'inject', outDir]);
    expect(lines[1]?.argv).toEqual([
      'debug-files',
      'upload',
      outDir,
      '--type',
      'sourcemaps',
      '--version',
      '1.2.3',
      '--build',
      '99',
    ]);
    // token + endpoint forwarded via env (never on argv).
    expect(lines[1]?.token).toBe('e2e-tok');
    expect(lines[1]?.endpoint).toBe('https://api.e2e.test');
    expect(lines.flatMap((l) => l.argv)).not.toContain('e2e-tok');

    // client .map deleted (privacy default); the .js kept.
    expect(existsSync(join(outDir, 'app.js.map'))).toBe(false);
    expect(existsSync(join(outDir, 'app.js'))).toBe(true);
  });

  it('runtime: a report stack carries the debugId a bundle registered via _bugseeDebugIds', () => {
    const g = globalThis as { _bugseeDebugIds?: Record<string, string> };
    const prev = g._bugseeDebugIds;
    g._bugseeDebugIds = { 'Error\n    at reg (https://cdn/app.js:1:1)': 'e2e-debug-id' };
    try {
      const frames: StackFrame[] = parseV8Stack('Error\n    at handler (https://cdn/app.js:42:9)');
      applyDebugIds(frames, { parseStack: parseV8Stack });
      expect(formatStack(frames)).toContain('debugId=e2e-debug-id');
    } finally {
      if (prev === undefined) delete g._bugseeDebugIds;
      else g._bugseeDebugIds = prev;
    }
  });
});
