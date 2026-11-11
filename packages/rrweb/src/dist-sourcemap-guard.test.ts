// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

// Guards the CLASS of bug behind the 0.1.0-beta.6 Angular break: a `//# sourceMappingURL=` comment at column
// 0 that is not the file's last line is deleted by Angular's esbuild builder, which (when it was the tail of
// the inlined worker template literal) took the closing backtick with it. The checker is
// scripts/check-dist-sourcemaps.mjs (also run in CI over every dist); this suite builds the REAL package.
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
    beforeAll(() => {
      execFileSync('pnpm', ['exec', 'tsup'], { cwd: pkgDir, stdio: 'pipe' });
    }, 120_000);

    for (const [file, format] of [
      ['dist/index.js', 'esm'],
      ['dist/index.cjs', 'cjs'],
    ] as const) {
      it(`${file} survives Angular's source-map stripping and keeps one trailing comment`, () => {
        const code = readFileSync(join(pkgDir, file), 'utf8');
        expect(guard.checkSource(code, format, parse)).toEqual([]);
        expect(code.match(/^\/\/# sourceMappingURL=/gm)).toHaveLength(1);
        // the inlined image-bitmap worker is still present and its string is intact
        expect(code).toContain('OffscreenCanvas');
        expect(code.replace(guard.ANGULAR_STRIP, '')).toContain('OffscreenCanvas');
      });
    }
  });
});
