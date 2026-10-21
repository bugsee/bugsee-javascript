import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Shared browser/WebView system events took the ANDROID names (C2). The old snake_case spellings must not come back
// anywhere in the package sources (code, tests, comments). The names are assembled so this file never matches itself.
const RETIRED = [
  ['orientation', 'changed'],
  ['dark_mode', 'changed'],
  ['process', 'foreground'],
  ['process', 'background'],
].map(([a, b]) => `${a}_${b}`);

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx|js|mjs|md)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('retired system-event names', () => {
  it('names the four retired spellings', () => {
    expect(new Set(RETIRED).size).toBe(4);
    expect(RETIRED.map((n) => n.split('_').length)).toEqual([2, 3, 2, 2]);
  });

  it('no package source mentions a retired name', () => {
    const files = readdirSync(PACKAGES).flatMap((pkg) => {
      const src = join(PACKAGES, pkg, 'src');
      try {
        return sources(src);
      } catch {
        return [];
      }
    });
    expect(files.length).toBeGreaterThan(100); // not vacuous
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return RETIRED.some((name) => text.includes(name));
    });
    expect(offenders).toEqual([]);
  });
});
