// Build-time tooling for tsup.config.ts only. It lives outside src/ because it imports node:fs and must
// never be reachable from the package's runtime entry.
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

// A `//# sourceMappingURL=` comment can be baked INTO a string by the upstream bundler that produced a
// prebuilt dependency (rrweb inlines its image-bitmap worker as a template literal that ends
// "...\n//# sourceMappingURL=worker.js.map`"). Inside a string it is dead text, but a consumer's toolchain
// that strips source-map comments line-wise (Angular's esbuild `application` builder runs
// `/^\/\/# sourceMappingURL=[^\r\n]*/gm` over every dependency) deletes the closing backtick with it and
// the file no longer parses. Removing it at build time means it is never emitted.
//
// Only a comment that STARTS a line and is followed by a backtick ON THE SAME LINE is touched: a real
// comment runs to end of line, so that shape can only be the tail of a template literal, and the line-start
// anchor mirrors exactly what the consumer's regex would hit.
const INLINE_SOURCEMAP_COMMENT = /(?:^|\r?\n)\/\/[#@] sourceMappingURL=[^\r\n`]*(?=`)/g;

export function stripInlineSourceMap(code: string): string {
  return code.replace(INLINE_SOURCEMAP_COMMENT, '');
}

function countInlineSourceMaps(code: string): number {
  return code.match(INLINE_SOURCEMAP_COMMENT)?.length ?? 0;
}

/**
 * esbuild plugin applying {@link stripInlineSourceMap} to every JS module the bundler loads.
 * With `expected`, the build FAILS when the number of stripped comments differs, so a vendor bump that
 * adds, removes or reshapes such a string surfaces instead of passing silently.
 */
export function stripInlineSourceMapPlugin(options: { expected?: number } = {}): Plugin {
  return {
    name: 'bugsee-strip-inline-sourcemap',
    setup(build) {
      let found = 0;
      build.onStart(() => {
        found = 0;
      });
      build.onLoad({ filter: /\.[cm]?js$/ }, async ({ path }) => {
        const code = await readFile(path, 'utf8');
        const n = countInlineSourceMaps(code);
        if (n === 0) return undefined;
        found += n;
        return { contents: stripInlineSourceMap(code), loader: 'js' };
      });
      build.onEnd(() => {
        if (options.expected !== undefined && found !== options.expected) {
          throw new Error(
            `expected ${options.expected} inlined sourceMappingURL comment(s), found ${found}`,
          );
        }
      });
    },
  };
}

/** tsup emits the trailing `//# sourceMappingURL=<file>.map` twice; keep one. */
export function dedupeTrailingSourceMap(code: string): string {
  return code.replace(/(\/\/# sourceMappingURL=[^\r\n]*)(\r?\n)\1(?=\r?\n?$)/, '$1');
}
