#!/usr/bin/env node
// Release gate: no published dist file may be broken by a consumer that strips source-map comments.
//
// Why: Angular's esbuild `application` builder (and others) run `/^\/\/# sourceMappingURL=[^\r\n]*/gm`
// over every dependency's JS. A `//# sourceMappingURL=` that sits at column 0 anywhere but the file's
// last line is therefore destroyed — and if it is the tail of an inlined template literal (rrweb's worker
// string, 0.1.0-beta.6) the closing backtick goes with it and the file stops parsing. This gate checks,
// for every `packages/*/dist/**/*.{js,cjs,mjs}`:
//   (a) a column-0 sourceMappingURL comment appears only in the file's trailing run of comment lines;
//   (b) after applying the regex exactly like Angular does, the file still parses.
//
//   pnpm --filter @bugsee/rrweb build && node scripts/check-dist-sourcemaps.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Angular's javascript-transformer-worker source-map stripping, verbatim. */
export const ANGULAR_STRIP = /^\/\/# sourceMappingURL=[^\r\n]*/gm;

const COMMENT = /^\/\/# sourceMappingURL=/;

/**
 * Line numbers (1-based) of column-0 sourceMappingURL comments that are NOT part of the file's trailing
 * run of such comments. tsup writes that trailing comment twice in every package; Angular's regex eats
 * trailing lines harmlessly, so only a comment followed by more code is dangerous.
 */
function midFileComments(code) {
  const lines = code.split(/\r?\n/);
  let end = lines.length;
  while (end > 0 && (lines[end - 1] === '' || COMMENT.test(lines[end - 1]))) end--;
  const hits = [];
  for (let i = 0; i < end; i++) if (COMMENT.test(lines[i])) hits.push(i + 1);
  return hits;
}

/**
 * Problems for one file's source. `parse(code, format)` throws when the code does not parse.
 * @param {string} code
 * @param {'esm'|'cjs'} format
 * @param {(code: string, format: 'esm'|'cjs') => void} parse
 * @returns {string[]}
 */
export function checkSource(code, format, parse) {
  const problems = [];
  for (const line of midFileComments(code))
    problems.push(`sourceMappingURL comment at column 0 on line ${line}, followed by more code`);
  try {
    parse(code.replace(ANGULAR_STRIP, ''), format);
  } catch (e) {
    problems.push(
      `does not parse after Angular's source-map stripping: ${String(e.message).split('\n')[0]}`,
    );
  }
  return problems;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(c|m)?js$/.test(name)) yield p;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { transformSync } = createRequire(join(root, 'packages/rrweb/package.json'))('esbuild');
  const parse = (code, format) => transformSync(code, { format, loader: 'js', logLevel: 'silent' });
  const errors = [];
  let scanned = 0;
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const dist = join(root, 'packages', pkg, 'dist');
    if (!existsSync(dist)) continue;
    for (const file of walk(dist)) {
      scanned++;
      const format = file.endsWith('.cjs') ? 'cjs' : 'esm';
      for (const p of checkSource(readFileSync(file, 'utf8'), format, parse))
        errors.push(`${file.slice(root.length + 1)}: ${p}`);
    }
  }
  if (!scanned)
    errors.push(
      'no packages/*/dist output found — build first (pnpm --filter @bugsee/rrweb build)',
    );
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`${scanned} dist file(s) safe against source-map-comment stripping.`);
}
