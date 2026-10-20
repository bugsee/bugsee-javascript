// The bundler plugins bake the app's version/build into the bundle, end to end: a REAL vite, webpack and
// esbuild build of a source that reads `typeof __BUGSEE_APP_VERSION__`, with the plugin given NO token.
// The literal must replace the identifier (the runtime SDK reads exactly these two constants), and a
// disabled plugin must leave the identifier alone.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bugseeEsbuildPlugin, bugseeRollupPlugin } from '@bugsee/bundler-plugin-core';
import { bugseeVitePlugin } from '@bugsee/vite-plugin';
import { bugseeWebpackPlugin } from '@bugsee/webpack-plugin';
import { build as esbuild } from 'esbuild';
import { rollup } from 'rollup';
import { parseAst } from 'rollup/parseAst';
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

  // Rollup has no `define`: the plugin rewrites each rendered chunk (with a source map) instead.
  it('rollup replaces both constants in the rendered chunk and keeps a source map', async () => {
    writeFileSync(
      join(dir, 'rollup-entry.js'),
      SOURCE.replace(/^declare .*$/gm, '').replace('export const', 'const'),
    );
    const outDir = join(dir, 'rollup-out');
    const bundle = await rollup({
      input: join(dir, 'rollup-entry.js'),
      plugins: [bugseeRollupPlugin(IDENTITY)],
    });
    await bundle.write({ dir: outDir, format: 'es', sourcemap: true });
    await bundle.close();
    const out = readFileSync(join(outDir, 'rollup-entry.js'), 'utf8');
    expect(out).toContain('7.8.9-e2e');
    expect(out).toContain('build-e2e');
    expect(out).not.toContain('__BUGSEE_APP_VERSION__');
    const map = JSON.parse(readFileSync(join(outDir, 'rollup-entry.js.map'), 'utf8')) as {
      mappings: string;
    };
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  // The bake rewrites only real references: a quoted name (here kept alive through an export) stays data,
  // and the chunk is still valid JavaScript (a lexical rewrite produced `""7.8.9-e2e""`).
  it('rollup leaves a quoted constant name alone and emits a chunk that parses', async () => {
    writeFileSync(
      join(dir, 'rollup-quoted.js'),
      [
        "export const key = '__BUGSEE_APP_VERSION__';",
        '// __BUGSEE_APP_BUILD__ in a comment',
        "export const v = typeof __BUGSEE_APP_VERSION__ === 'string' ? __BUGSEE_APP_VERSION__ : 'none';",
      ].join('\n'),
    );
    const outDir = join(dir, 'rollup-quoted');
    const bundle = await rollup({
      input: join(dir, 'rollup-quoted.js'),
      plugins: [bugseeRollupPlugin(IDENTITY)],
    });
    await bundle.write({ dir: outDir, format: 'es', sourcemap: true });
    await bundle.close();
    const out = readFileSync(join(outDir, 'rollup-quoted.js'), 'utf8');
    expect(out).toContain("const key = '__BUGSEE_APP_VERSION__';");
    expect(out).toContain('typeof "7.8.9-e2e" === \'string\' ? "7.8.9-e2e"');
    expect(() => parseAst(out)).not.toThrow();
  });

  // A parameter named like the constant is the app's own variable: baking its reads would silently change what
  // the function computes (here `helper(3)` must still be 6, not `"3" * 2` of a baked literal in the body).
  it('rollup does not bake a local binding that shares the constant name', async () => {
    writeFileSync(
      join(dir, 'rollup-local-helper.js'),
      'export function helper(__BUGSEE_APP_BUILD__) { return __BUGSEE_APP_BUILD__ * 2; }\n',
    );
    writeFileSync(
      join(dir, 'rollup-local-entry.js'),
      [
        "import { helper } from './rollup-local-helper.js';",
        'export const doubled = helper(3);',
        'export const build = typeof __BUGSEE_APP_BUILD__ === "string" ? __BUGSEE_APP_BUILD__ : "none";',
      ].join('\n'),
    );
    const outDir = join(dir, 'rollup-local');
    const bundle = await rollup({
      input: join(dir, 'rollup-local-entry.js'),
      plugins: [bugseeRollupPlugin({ ...IDENTITY, appBuild: 'b-local' })],
    });
    await bundle.write({ dir: outDir, format: 'es', entryFileNames: '[name].mjs' });
    await bundle.close();
    const file = join(outDir, 'rollup-local-entry.mjs');
    const out = readFileSync(file, 'utf8');
    expect(out).toMatch(
      /function helper\(__BUGSEE_APP_BUILD__\) \{ return __BUGSEE_APP_BUILD__ \* 2; \}/,
    );
    const mod = (await import(pathToFileURL(file).href)) as { doubled: number; build: string };
    expect(mod.doubled).toBe(6);
    expect(mod.build).toBe('b-local');
  });

  it('a disabled plugin leaves the identifiers alone (rollup)', async () => {
    const outDir = join(dir, 'rollup-disabled');
    const bundle = await rollup({
      input: join(dir, 'rollup-entry.js'),
      plugins: [bugseeRollupPlugin({ ...IDENTITY, disabled: true })],
    });
    await bundle.write({ dir: outDir, format: 'es' });
    await bundle.close();
    expect(readFileSync(join(outDir, 'rollup-entry.js'), 'utf8')).toContain('no-version');
  });
});
