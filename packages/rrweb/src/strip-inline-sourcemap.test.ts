// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
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
});

describe('stripInlineSourceMapPlugin (esbuild integration)', () => {
  const run = async (body: string): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'rrweb-sm-'));
    const file = join(dir, 'entry.js');
    writeFileSync(file, body);
    const out = await build({
      entryPoints: [file],
      bundle: true,
      write: false,
      format: 'esm',
      plugins: [stripInlineSourceMapPlugin()],
    });
    return out.outputFiles[0]?.text ?? '';
  };

  it('strips the comment from a loaded module so the emitted string stays terminated', async () => {
    const text = await run('export const w = `a();\n//# sourceMappingURL=w.js.map`;\n');
    expect(text).not.toContain('sourceMappingURL');
    expect(text).toContain('a();');
  });

  it('passes a module without such a comment through to esbuild unchanged', async () => {
    const text = await run('export const w = 1;\n');
    expect(text).toContain('w = 1');
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
