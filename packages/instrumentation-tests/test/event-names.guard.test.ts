import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Shared browser/WebView system events took the ANDROID names (C2). The old snake_case spellings must not come back
// anywhere in the repo (code, tests, e2e, samples, docs; release notes and the dated history files are exempt). The names are assembled so this file never matches itself.
const RETIRED = [
  ['orientation', 'changed'],
  ['dark_mode', 'changed'],
  ['process', 'foreground'],
  ['process', 'background'],
].map(([a, b]) => `${a}_${b}`);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.turbo',
  '.local-registry',
  '.changeset', // release notes are history
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.astro',
]);
// Dated history that legitimately keeps the names as they were when written.
const SKIP_FILES = new Set([join('docs', 'PROGRESS.md'), join('docs', 'review', 'browser.md')]);
const SCANNED = /\.(ts|tsx|js|mjs|cjs|md|vue|svelte|astro|html|json|ya?ml)$/;
const SELF = fileURLToPath(import.meta.url);

/** Every scanned file under `dir` (the whole repo from the root: sources, tests, e2e, samples, dev-packages, docs). */
export function scannedFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...scannedFiles(full));
    else if (SCANNED.test(entry) && full !== SELF && !SKIP_FILES.has(relative(ROOT, full)))
      out.push(full);
  }
  return out;
}

/** The files under `dir` that mention a retired name. */
export function offendersIn(dir: string): string[] {
  return scannedFiles(dir).filter((file) => {
    const text = readFileSync(file, 'utf8');
    return RETIRED.some((name) => text.includes(name));
  });
}

describe('retired system-event names', () => {
  it('names the four retired spellings', () => {
    expect(new Set(RETIRED).size).toBe(4);
    expect(RETIRED.map((n) => n.split('_').length)).toEqual([2, 3, 2, 2]);
  });

  it('nothing in the repo (sources, tests, e2e, samples, docs) mentions a retired name', () => {
    expect(scannedFiles(ROOT).length).toBeGreaterThan(500); // not vacuous
    expect(offendersIn(ROOT).map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('probe: a retired name in a scanned file IS reported, in a skipped dir or unscanned type it is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-names-guard-'));
    try {
      mkdirSync(join(dir, 'src'));
      mkdirSync(join(dir, 'node_modules'));
      writeFileSync(join(dir, 'src', 'a.vue'), `emit('${RETIRED[0]}')`);
      writeFileSync(join(dir, 'src', 'clean.ts'), 'emit("OrientationChanged")');
      writeFileSync(join(dir, 'src', 'a.png'), RETIRED[1] as string);
      writeFileSync(join(dir, 'node_modules', 'b.ts'), RETIRED[2] as string);
      expect(offendersIn(dir).map((f) => relative(dir, f))).toEqual([join('src', 'a.vue')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
