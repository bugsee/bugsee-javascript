// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import {
  dedupeTrailingSourceMap,
  stripInlineSourceMap,
  stripInlineSourceMapPlugin,
} from './strip-inline-sourcemap';

describe('stripInlineSourceMap', () => {
  it('removes a sourceMappingURL comment inside a template literal (closing backtick on the same line)', () => {
    const src = 'const w = `code();\n//# sourceMappingURL=worker.js.map`;\nexport { w };\n';
    expect(stripInlineSourceMap(src)).toBe('const w = `code();`;\nexport { w };\n');
  });

  it('handles CRLF and the legacy //@ form', () => {
    expect(stripInlineSourceMap('x=`a\r\n//@ sourceMappingURL=a.map`;')).toBe('x=`a`;');
  });

  it('leaves a real trailing comment (no backtick after it on the line) untouched', () => {
    const src = 'a();\n//# sourceMappingURL=index.js.map\n';
    expect(stripInlineSourceMap(src)).toBe(src);
  });

  it('leaves a comment whose closing backtick is on the NEXT line untouched', () => {
    const src = 'x=`a\n//# sourceMappingURL=a.map\n`;';
    expect(stripInlineSourceMap(src)).toBe(src);
  });

  it('only matches a comment at the START of a line (not mid-line string concatenation)', () => {
    const src = 'const s = "//# sourceMappingURL=" + `x`;';
    expect(stripInlineSourceMap(src)).toBe(src);
    const src2 = 'const s = "//# sourceMappingURL=a.map`";';
    expect(stripInlineSourceMap(src2)).toBe(src2);
  });

  it('matches at the very start of the file', () => {
    expect(stripInlineSourceMap('//# sourceMappingURL=a.map`x')).toBe('`x');
  });
});

describe('stripInlineSourceMapPlugin (esbuild integration)', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const run = async (body: string, expected?: number): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'rrweb-sm-'));
    dirs.push(dir);
    const file = join(dir, 'entry.js');
    writeFileSync(file, body);
    const out = await build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: 'esm',
      logLevel: 'silent',
      plugins: [stripInlineSourceMapPlugin(expected === undefined ? {} : { expected })],
    });
    return out.outputFiles[0]?.text ?? '';
  };
  const withComment = 'export const w = `a();\n//# sourceMappingURL=w.js.map`;\n';

  it('strips the comment from a loaded module so the emitted string stays terminated', async () => {
    const text = await run(withComment);
    expect(text).not.toContain('sourceMappingURL');
    expect(text).toContain('a();');
  });

  it('passes a module without such a comment through to esbuild unchanged', async () => {
    const text = await run('export const w = 1;\n');
    expect(text).toContain('w = 1');
  });

  it('succeeds when the number of stripped comments equals the expected count', async () => {
    expect(await run(withComment, 1)).not.toContain('sourceMappingURL');
  });

  it('fails the build loudly when fewer comments are found than expected (vendor changed)', async () => {
    await expect(run('export const w = 1;\n', 1)).rejects.toThrow(/expected 1.*found 0/);
  });

  it('fails the build loudly when more comments are found than expected', async () => {
    await expect(run(withComment, 0)).rejects.toThrow(/expected 0.*found 1/);
  });
});

describe('dedupeTrailingSourceMap', () => {
  it('collapses a repeated trailing sourceMappingURL comment to one', () => {
    const c = 'a();\n//# sourceMappingURL=index.js.map\n//# sourceMappingURL=index.js.map\n';
    expect(dedupeTrailingSourceMap(c)).toBe('a();\n//# sourceMappingURL=index.js.map\n');
  });

  it('collapses duplicates when the file has no final newline', () => {
    const c = 'a();\n//# sourceMappingURL=i.map\n//# sourceMappingURL=i.map';
    expect(dedupeTrailingSourceMap(c)).toBe('a();\n//# sourceMappingURL=i.map');
  });

  it('leaves a single trailing comment, and distinct comments, untouched', () => {
    const one = 'a();\n//# sourceMappingURL=index.js.map\n';
    expect(dedupeTrailingSourceMap(one)).toBe(one);
    const two = 'a();\n//# sourceMappingURL=a.map\n//# sourceMappingURL=b.map\n';
    expect(dedupeTrailingSourceMap(two)).toBe(two);
  });
});
