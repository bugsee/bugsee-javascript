// Issue #185 — `node --enable-source-maps` vs the debug-ID -> file lookup.
//
// Builds a REAL minified-position bundle with esbuild (+ external map), stamps it the way
// `bugsee-cli sourcemaps inject` does (the runtime stub and the `//# debugId=` comment APPENDED after the whole bundle,
// so the stub has no source-map mapping of its own), then runs it in a real node/bun process through the REAL crash
// builder (`buildCrashJson`) and reads back which frames got a debug-ID.
//
// A debug-ID tells the backend "this position is in the stamped bundle, remap it". Stamping a frame the runtime already
// mapped to an original `src/*.js` position makes the backend remap it AGAIN -> a wrong line. But the flag alone does
// not mean frames are mapped: the plugin deletes `*.map` after upload by default (then Node cannot map anything), and
// `process.setSourceMapsEnabled(true)` only affects modules loaded afterwards. Those cases must stay stamped.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runtimeTargets } from './runtimes';

const DEBUG_ID = '11111111-2222-5333-8444-555555555555';
const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const SCENARIO = join(pkgRoot, 'app', 'sourcemaps-runtime-scenario.ts');

/** The stub `bugsee-cli sourcemaps inject` appends (same shape: registers `Error().stack` -> debug-id). */
const STUB = `;!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._bugseeDebugIds=e._bugseeDebugIds||{},e._bugseeDebugIds[n]="${DEBUG_ID}")}catch(e){}}();`;

interface Result {
  sourceMapsEnabled: boolean | undefined;
  registrationTopFrames: string[];
  frames: { at: string; debug_id?: string }[];
}

describe('debug-ID stamping under runtime source-map support (#185)', () => {
  let dir: string;
  /** Build roots: one keeps `app.js.map` on disk, one has it deleted (the plugin's default after upload). */
  let withMap: string;
  let noMap: string;
  let esmMap: string;
  let esmNoMap: string;
  let underSpace: string;
  let underQuery: string;

  function build(root: string, keepMap: boolean, esm = false, name?: string): void {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'dist'));
    writeFileSync(
      join(root, 'src', 'a.js'),
      "export function boom() {\n  throw new Error('boom from a');\n}\n",
    );
    writeFileSync(
      join(root, 'src', 'main.js'),
      "import { boom } from './a.js';\nexport function fail() {\n  boom();\n}\n",
    );
    const bundle = join(root, 'dist', name ?? (esm ? 'app.mjs' : 'app.js'));
    execFileSync(
      join(pkgRoot, 'node_modules', '.bin', 'esbuild'),
      [
        join(root, 'src', 'main.js'),
        '--bundle',
        '--platform=node',
        `--format=${esm ? 'esm' : 'cjs'}`,
        '--sourcemap',
        `--outfile=${bundle}`,
        '--log-level=warning',
      ],
      { stdio: 'inherit' },
    );
    // inject: stub, then the id comment LAST, appended after the whole bundle (bugsee-cli inject/mod.rs).
    const source = readFileSync(bundle, 'utf8');
    writeFileSync(bundle, `${source.replace(/\n$/, '')}\n${STUB}\n//# debugId=${DEBUG_ID}\n`);
    if (!keepMap) rmSync(`${bundle}.map`);
  }

  beforeAll(() => {
    // realpath: macOS tmpdir is a symlink; Node would map frames to a nonexistent `/private/private/...` path and the
    // verifier would reject for 'file missing' rather than 'no stamp', which makes the map-present cases tautological.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'bugsee-sm-rt-')));
    withMap = join(dir, 'with-map');
    noMap = join(dir, 'no-map');
    mkdirSync(withMap);
    mkdirSync(noMap);
    build(withMap, true);
    build(noMap, false);
    // ESM bundles under a directory with a SPACE: Node prints the frame as `file:///…/my%20app/dist/app.mjs`.
    esmMap = join(dir, 'my app', 'esm-map');
    esmNoMap = join(dir, 'my app', 'esm-no-map');
    mkdirSync(esmMap, { recursive: true });
    mkdirSync(esmNoMap, { recursive: true });
    build(esmMap, true, true);
    build(esmNoMap, false, true);
    // ESM bundles UNDER the app root (the common case: appRoot = cwd). Core scrubs the frame to `./dist/...` WITHOUT
    // decoding it, so a space in the file name stays `%20`, and an import query stays in the path.
    underSpace = join(dir, 'under-space');
    underQuery = join(dir, 'under-query');
    mkdirSync(underSpace);
    mkdirSync(underQuery);
    build(underSpace, false, true, 'my chunk.mjs');
    build(underQuery, false, true);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(
    bin: string,
    root: string,
    args: string[],
    sourceMaps: 'on' | 'off' | 'late',
    bundleName?: string,
    importQuery = '',
  ): Result {
    const out = execFileSync(bin, [...args, SCENARIO], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BUNDLE_PATH: join(
          root,
          'dist',
          bundleName ?? (root.includes('esm') ? 'app.mjs' : 'app.js'),
        ),
        IMPORT_QUERY: importQuery,
        APP_ROOT: root,
        SOURCE_MAPS: sourceMaps,
      },
    });
    return JSON.parse(out.trim().split('\n').at(-1) as string) as Result;
  }

  const bundleFrames = (r: Result) => r.frames.filter((f) => f.at.includes('dist/'));
  const originalFrames = (r: Result) => r.frames.filter((f) => f.at.includes('src/'));

  for (const target of runtimeTargets()) {
    const { bin, name } = target;
    it.skipIf(bin === undefined)(
      `${name}: ESM bundle under a path with a space, flag on, map deleted -> stays stamped`,
      () => {
        const r = run(bin as string, esmNoMap, ['--enable-source-maps'], 'on');
        // Node prints the ESM frame as a percent-encoded file URL; Bun prints the plain path.
        expect(r.registrationTopFrames[0]).toContain(name === 'node' ? 'my%20app' : 'my app');
        expect(originalFrames(r)).toHaveLength(0);
        expect(bundleFrames(r).length).toBeGreaterThan(0);
        for (const f of bundleFrames(r)) expect(f.debug_id).toBe(DEBUG_ID);
      },
    );

    it.skipIf(bin === undefined)(
      `${name}: ESM bundle UNDER the app root with a space in its NAME, flag on, map deleted -> stays stamped`,
      () => {
        const r = run(bin as string, underSpace, ['--enable-source-maps'], 'on', 'my chunk.mjs');
        // Node: the frame is scrubbed to `./dist/my%20chunk.mjs` (relative, still encoded); Bun: the plain relative path.
        expect(bundleFrames(r)[0]?.at).toContain(
          name === 'node' ? './dist/my%20chunk.mjs' : './dist/my chunk.mjs',
        );
        expect(originalFrames(r)).toHaveLength(0);
        expect(bundleFrames(r).length).toBeGreaterThan(0);
        for (const f of bundleFrames(r)) expect(f.debug_id).toBe(DEBUG_ID);
      },
    );

    it.skipIf(bin === undefined)(
      `${name}: ESM bundle UNDER the app root imported with a ?v=1 query, flag on, map deleted -> stays stamped`,
      () => {
        const r = run(bin as string, underQuery, ['--enable-source-maps'], 'on', 'app.mjs', '?v=1');
        expect(bundleFrames(r)[0]?.at).toContain('./dist/app.mjs');
        expect(bundleFrames(r).length).toBeGreaterThan(0);
        for (const f of bundleFrames(r)) expect(f.debug_id).toBe(DEBUG_ID);
      },
    );

    it.skipIf(bin === undefined)(
      `${name}: ESM bundle under a path with a space, flag on, map present -> mapped frames are not stamped`,
      () => {
        const r = run(bin as string, esmMap, ['--enable-source-maps'], 'on');
        if (name === 'node') {
          expect(originalFrames(r).length).toBeGreaterThanOrEqual(2);
          expect(r.frames.map((f) => f.debug_id)).not.toContain(DEBUG_ID);
        } else {
          for (const f of bundleFrames(r)) expect(f.debug_id).toBe(DEBUG_ID); // Bun does not map
        }
      },
    );

    const flag = ['--enable-source-maps'];

    it.skipIf(bin === undefined)(`${name}: source maps off -> bundle frames are stamped`, () => {
      const r = run(bin as string, withMap, [], 'off');
      expect(r.sourceMapsEnabled).not.toBe(true);
      expect(r.registrationTopFrames[0]).toContain('dist/app.js');
      expect(bundleFrames(r).length).toBeGreaterThan(0);
      for (const f of bundleFrames(r)) expect(f.debug_id).toBe(DEBUG_ID);
    });

    it.skipIf(bin === undefined)(
      `${name}: --enable-source-maps never stamps an already-mapped frame`,
      () => {
        const r = run(bin as string, withMap, flag, 'on');
        if (name === 'node') {
          // Node maps the stacks BEFORE the SDK sees them: error frames AND the registration key's top frame are
          // original `src/*.js` positions, so the bundle's id would be wrong for every one of them.
          expect(r.sourceMapsEnabled).toBe(true);
          expect(r.registrationTopFrames[0]).toContain('/src/');
          expect(originalFrames(r).length).toBeGreaterThanOrEqual(2);
          expect(r.frames.map((f) => f.debug_id)).not.toContain(DEBUG_ID);
        } else {
          // Measured (Bun 1.4.4): Bun does NOT apply source maps to Error.stack and has no
          // `process.sourceMapsEnabled`, so frames stay on the bundle and stamping them is correct.
          expect(originalFrames(r)).toHaveLength(0);
          expect(bundleFrames(r).length).toBeGreaterThan(0);
          for (const f of bundleFrames(r)) expect(f.debug_id).toBe(DEBUG_ID);
        }
      },
    );

    it.skipIf(bin === undefined)(
      `${name}: flag on but the map was deleted (plugin default) -> nothing is mapped, frames stay stamped`,
      () => {
        const r = run(bin as string, noMap, flag, 'on');
        expect(r.registrationTopFrames[0]).toContain('dist/app.js');
        expect(originalFrames(r)).toHaveLength(0);
        expect(bundleFrames(r).length).toBeGreaterThan(0);
        for (const f of bundleFrames(r)) expect(f.debug_id).toBe(DEBUG_ID);
      },
    );

    it.skipIf(bin === undefined)(
      `${name}: source maps enabled AFTER the bundle loaded -> frames are unmapped and stay stamped`,
      () => {
        const r = run(bin as string, withMap, [], 'late');
        if (name === 'node') expect(r.sourceMapsEnabled).toBe(true);
        expect(r.registrationTopFrames[0]).toContain('dist/app.js');
        expect(originalFrames(r)).toHaveLength(0);
        expect(bundleFrames(r).length).toBeGreaterThan(0);
        for (const f of bundleFrames(r)) expect(f.debug_id).toBe(DEBUG_ID);
      },
    );
  }
});
