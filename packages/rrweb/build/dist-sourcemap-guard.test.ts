// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Guards the CLASS of bug behind the 0.1.0-beta.6 Angular break: a `//# sourceMappingURL=` comment at column
// 0 that is not the file's last line is deleted by Angular's esbuild builder, which (when it was the tail of
// the inlined worker template literal) took the closing backtick with it. The checker is
// scripts/check-dist-sourcemaps.mjs (also run in CI over every dist); this suite builds the REAL package
// into a TEMP directory, so it never cleans the package's own dist/ under a concurrent turbo build.
type Guard = {
  ANGULAR_STRIP: RegExp;
  checkSource: (
    code: string,
    format: 'esm' | 'cjs',
    parse: (code: string, format: 'esm' | 'cjs') => void,
  ) => string[];
};

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, '..');
const guardPath = resolve(pkgDir, '../../scripts/check-dist-sourcemaps.mjs');
const parse = (code: string, format: 'esm' | 'cjs'): void => {
  transformSync(code, { format, loader: 'js', logLevel: 'silent' });
};

/** The inlined worker source: the template literal that opens with `(function() {`, evaluated. */
function extractWorker(code: string): string {
  const m = /= `(\(function\(\) \{[\s\S]*?)`;\n(?:var|const|let) /.exec(code);
  if (!m) throw new Error('inlined worker literal not found');
  return vm.runInNewContext(`\`${m[1]}\``) as string;
}

describe('dist source-map-comment guard', () => {
  let guard: Guard;
  beforeAll(async () => {
    guard = (await import(pathToFileURL(guardPath).href)) as Guard;
  });

  it('flags the beta.6 shape: a comment at column 0 closing a template literal on the same line', () => {
    const bad = 'const w = `x();\n//# sourceMappingURL=w.js.map`;\nexport { w };\n';
    const problems = guard.checkSource(bad, 'esm', parse);
    expect(problems.some((p) => /followed by more code/.test(p))).toBe(true);
    expect(problems.some((p) => /does not parse/.test(p))).toBe(true);
  });

  it('accepts a trailing run of comments (tsup duplicates it) and a single one', () => {
    const dup = 'a();\n//# sourceMappingURL=i.map\n//# sourceMappingURL=i.map';
    expect(guard.checkSource(dup, 'esm', parse)).toEqual([]);
    expect(guard.checkSource('a();\n//# sourceMappingURL=i.map\n', 'esm', parse)).toEqual([]);
  });

  describe('the built package', () => {
    let outDir: string;
    beforeAll(() => {
      outDir = mkdtempSync(join(tmpdir(), 'rrweb-dist-'));
      execFileSync('pnpm', ['exec', 'tsup', '--out-dir', outDir], {
        cwd: pkgDir,
        stdio: 'pipe',
        env: { ...process.env, BUGSEE_RRWEB_OUT_DIR: outDir },
      });
    }, 120_000);
    afterAll(() => rmSync(outDir, { recursive: true, force: true }));

    for (const [file, format] of [
      ['index.js', 'esm'],
      ['index.cjs', 'cjs'],
    ] as const) {
      it(`${file} survives Angular's source-map stripping and keeps one trailing comment`, () => {
        const code = readFileSync(join(outDir, file), 'utf8');
        expect(guard.checkSource(code, format, parse)).toEqual([]);
        expect(code.match(/^\/\/# sourceMappingURL=/gm)).toHaveLength(1);
      });

      it(`${file}: the inlined worker survives the stripping, parses and answers messages`, async () => {
        const stripped = readFileSync(join(outDir, file), 'utf8').replace(guard.ANGULAR_STRIP, '');
        const worker = extractWorker(stripped);
        expect(worker).not.toContain('sourceMappingURL');
        // syntax check (node --check equivalent)
        expect(() => new vm.Script(worker)).not.toThrow();
        // behavioural smoke: run it against a fake worker global + OffscreenCanvas and post a message
        const posted: unknown[] = [];
        class FakeCanvas {
          constructor(readonly w: number) {}
          getContext() {
            return { drawImage() {} };
          }
          async convertToBlob() {
            const w = this.w;
            return {
              type: 'image/png',
              arrayBuffer: async () => new Uint8Array([1, 2, 3, w]).buffer,
            };
          }
        }
        const self = {
          postMessage: (m: unknown) => posted.push(m),
          onmessage: undefined as unknown,
        };
        const ctx = vm.createContext({ self, OffscreenCanvas: FakeCanvas, Map, Uint8Array });
        vm.runInContext(worker, ctx);
        const onmessage = self.onmessage as (e: unknown) => Promise<void>;
        await onmessage({
          data: { id: 1, bitmap: { close() {} }, width: 5, height: 5, dataURLOptions: {} },
        });
        expect(posted).toHaveLength(1);
        expect(JSON.stringify(posted[0])).toContain('"id":1');
      });
    }
  });
});
