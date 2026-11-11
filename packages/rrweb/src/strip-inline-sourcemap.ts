import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

// A `//# sourceMappingURL=` comment can be baked INTO a string by the upstream bundler that produced a
// prebuilt dependency (rrweb inlines its image-bitmap worker as a template literal that ends
// "...\n//# sourceMappingURL=worker.js.map`"). Inside a string it is dead text, but a consumer's toolchain
// that strips source-map comments line-wise (Angular's esbuild `application` builder runs
// `/^\/\/# sourceMappingURL=[^\r\n]*/gm` over every dependency) deletes the closing backtick with it and
// the file no longer parses. Removing it at build time means it is never emitted.
//
// Only a comment followed by a backtick ON THE SAME LINE is touched: a real comment runs to end of line,
// so that shape can only be the tail of a template literal.
const INLINE_SOURCEMAP_COMMENT = /\r?\n?\/\/[#@] sourceMappingURL=[^\r\n`]*(?=`)/g;

export function stripInlineSourceMap(code: string): string {
  return code.replace(INLINE_SOURCEMAP_COMMENT, '');
}

/** esbuild plugin applying {@link stripInlineSourceMap} to every JS module the bundler loads. */
export function stripInlineSourceMapPlugin(): Plugin {
  return {
    name: 'bugsee-strip-inline-sourcemap',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?js$/ }, async ({ path }) => {
        const code = await readFile(path, 'utf8');
        const stripped = stripInlineSourceMap(code);
        if (stripped === code) return undefined;
        return { contents: stripped, loader: 'js' };
      });
    },
  };
}

/** tsup emits the trailing `//# sourceMappingURL=<file>.map` twice; keep one. */
export function dedupeTrailingSourceMap(code: string): string {
  return code.replace(/(\/\/# sourceMappingURL=[^\r\n]*)(\r?\n)\1(?=\r?\n?$)/, '$1');
}
