// Issue #185 — `node --enable-source-maps` vs the debug-ID -> file lookup.
//
// Builds a REAL bundle with esbuild (+ external map), stamps it the way `bugsee-cli sourcemaps inject` does
// (runtime stub + `//# debugId=` comment appended AFTER the bundle, so the stub has no source-map mapping),
// then runs it in a real node/bun process through the REAL crash builder (`buildCrashJson`) and reads back
// which frames got a debug-ID. The bundle's debug-ID tells the backend "this position is in the MINIFIED
// bundle, remap it"; stamping a frame that the runtime already mapped to an original `src/*.js` position would
// make the backend remap it AGAIN and show a wrong line.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  let bundle: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bugsee-sm-rt-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'dist'));
    writeFileSync(
      join(dir, 'src', 'a.js'),
      "export function boom() {\n  throw new Error('boom from a');\n}\n",
    );
    writeFileSync(
      join(dir, 'src', 'main.js'),
      "import { boom } from './a.js';\nexport function fail() {\n  boom();\n}\n",
    );
    bundle = join(dir, 'dist', 'app.js');
    execFileSync(
      join(pkgRoot, 'node_modules', '.bin', 'esbuild'),
      [
        join(dir, 'src', 'main.js'),
        '--bundle',
        '--platform=node',
        '--format=cjs',
        '--sourcemap',
        `--outfile=${bundle}`,
        '--log-level=warning',
      ],
      { stdio: 'inherit' },
    );
    // inject: stub + id comment go BEFORE the trailing sourceMappingURL comment, as the CLI leaves it.
    const lines = readFileSync(bundle, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.startsWith('//# sourceMappingURL='));
    lines.splice(at, 0, STUB, `//# debugId=${DEBUG_ID}`);
    writeFileSync(bundle, lines.join('\n'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(bin: string, args: string[], sourceMaps?: 'on' | 'off'): Result {
    const out = execFileSync(bin, [...args, SCENARIO], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BUNDLE_PATH: bundle,
        ...(sourceMaps ? { SOURCE_MAPS: sourceMaps } : {}),
      },
    });
    return JSON.parse(out.trim().split('\n').at(-1) as string) as Result;
  }

  for (const target of runtimeTargets()) {
    const { bin } = target;
    it.skipIf(bin === undefined)(
      `${target.name}: default (no source maps) stamps the bundle frames`,
      () => {
        const r = run(bin as string, [], 'off');
        expect(r.sourceMapsEnabled).not.toBe(true);
        expect(r.registrationTopFrames[0]).toContain('dist/app.js');
        const user = r.frames.filter((f) => f.at.includes('dist/app.js'));
        expect(user.length).toBeGreaterThan(0);
        for (const f of user) expect(f.debug_id).toBe(DEBUG_ID);
      },
    );

    it.skipIf(bin === undefined)(
      `${target.name}: --enable-source-maps never stamps an already-mapped frame`,
      () => {
        const r = run(bin as string, ['--enable-source-maps'], 'on');
        const original = r.frames.filter((f) => f.at.includes('/src/'));
        if (target.name === 'node') {
          // Node maps the stacks BEFORE the SDK sees them: error frames AND the registration key's top frame
          // are original `src/*.js` positions, so the bundle's id would be wrong for every one of them.
          expect(r.sourceMapsEnabled).toBe(true);
          expect(r.registrationTopFrames[0]).toContain('/src/');
          expect(original.length).toBeGreaterThanOrEqual(2);
        }
        // Whatever the runtime did, a frame that points at an ORIGINAL source must carry no debug-id.
        for (const f of original) expect(f.debug_id).toBeUndefined();
        if (target.name === 'bun') {
          // Measured (Bun 1.4.4): Bun does NOT apply source maps to Error.stack (no `process.sourceMapsEnabled`),
          // so frames stay on the bundle and stamping them is correct.
          expect(original).toHaveLength(0);
          for (const f of r.frames.filter((x) => x.at.includes('dist/app.js'))) {
            expect(f.debug_id).toBe(DEBUG_ID);
          }
        }
      },
    );
  }
});
