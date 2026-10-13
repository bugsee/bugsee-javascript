// The bundler plugins bake the app's version/build into the bundle, end to end: a REAL vite, webpack and
// esbuild build of a source that reads `typeof __BUGSEE_APP_VERSION__`, with the plugin given NO token.
// The literal must replace the identifier (the runtime SDK reads exactly these two constants), and a
// disabled plugin must leave the identifier alone.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bugseeEsbuildPlugin } from '@bugsee/bundler-plugin-core';
import { bugseeVitePlugin } from '@bugsee/vite-plugin';
import { bugseeWebpackPlugin } from '@bugsee/webpack-plugin';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import webpack from 'webpack';

const SOURCE = `
declare const __BUGSEE_APP_VERSION__: string;
declare const __BUGSEE_APP_BUILD__: string;
export const identity = [
  typeof __BUGSEE_APP_VERSION__ !== 'undefined' ? __BUGSEE_APP_VERSION__ : 'no-version',
  typeof __BUGSEE_APP_BUILD__ !== 'undefined' ? __BUGSEE_APP_BUILD__ : 'no-build',
].join('|');
console.log(identity);
`;

const IDENTITY = { appVersion: '7.8.9-e2e', appBuild: 'build-e2e' };

let dir: string;
let entry: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugsee-identity-'));
  entry = join(dir, 'entry.ts');
  writeFileSync(entry, SOURCE);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function viteOutput(options: Record<string, unknown>): Promise<string> {
  const outDir = join(dir, `vite-${Math.random().toString(36).slice(2)}`);
  await viteBuild({
    root: dir,
    logLevel: 'silent',
    configFile: false,
    plugins: [bugseeVitePlugin(options)],
    build: {
      outDir,
      minify: false,
      lib: { entry, formats: ['es'], fileName: 'out' },
    },
  });
  const file = readdirSync(outDir).find((name) => name.endsWith('.js') || name.endsWith('.mjs'));
  return readFileSync(join(outDir, file ?? 'missing.js'), 'utf8');
}

async function esbuildOutput(options: Record<string, unknown>): Promise<string> {
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    write: false,
    logLevel: 'silent',
    plugins: [bugseeEsbuildPlugin(options)],
  });
  return result.outputFiles[0]?.text ?? '';
}

describe('app identity is baked into the bundle', () => {
  it('vite replaces both constants with the resolved literals, with no app token', async () => {
    const out = await viteOutput(IDENTITY);
    expect(out).toContain('7.8.9-e2e');
    expect(out).toContain('build-e2e');
    expect(out).not.toContain('__BUGSEE_APP_VERSION__');
  });

  it('esbuild replaces both constants', async () => {
    const out = await esbuildOutput(IDENTITY);
    expect(out).toContain('7.8.9-e2e');
    expect(out).toContain('build-e2e');
    expect(out).not.toContain('__BUGSEE_APP_VERSION__');
  });

  it('a disabled plugin leaves the identifiers alone (vite)', async () => {
    const out = await viteOutput({ ...IDENTITY, disabled: true });
    expect(out).not.toContain('7.8.9-e2e');
    expect(out).toContain('no-version');
  });

  it('webpack replaces both constants', async () => {
    writeFileSync(
      join(dir, 'entry.js'),
      SOURCE.replace(/^declare .*$/gm, '').replace('export const', 'const'),
    );
    const path = join(dir, 'webpack-out');
    await new Promise<void>((resolve, reject) => {
      webpack(
        {
          mode: 'development',
          devtool: false,
          context: dir,
          entry: join(dir, 'entry.js'),
          output: { path, filename: 'out.js' },
          plugins: [bugseeWebpackPlugin(IDENTITY)],
        },
        (error, stats) =>
          error || stats?.hasErrors()
            ? reject(error ?? new Error(stats?.toString({ all: false, errors: true })))
            : resolve(),
      );
    });
    const out = readFileSync(join(path, 'out.js'), 'utf8');
    expect(out).toContain('7.8.9-e2e');
    expect(out).toContain('build-e2e');
    expect(out).not.toContain('__BUGSEE_APP_VERSION__');
  });
});
