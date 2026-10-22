import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// C21 guard: `client.addBreadcrumb` applies NO sanitizer (a breadcrumb is application data), so a package that
// writes a breadcrumb carrying a URL must sanitize that URL itself. The Next.js navigation breadcrumb once wrote
// the raw `href` (`?code=…`, `#access_token=…`). This test pins EVERY SDK-internal call site of
// `addBreadcrumb(` and classifies it, so a new writer cannot land without someone deciding whether it carries a URL.

const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|vue|svelte|astro)$/.test(name) && !/\.(test|test-d)\.ts$/.test(name)
      ? [full]
      : [];
  });
}

const callSites = (): Map<string, string> => {
  const found = new Map<string, string>();
  for (const pkg of readdirSync(packages)) {
    const src = join(packages, pkg, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8');
      if (/\.addBreadcrumb\(/.test(text)) found.set(relative(packages, file), text);
    }
  }
  return found;
};

describe('every SDK-internal breadcrumb writer is classified (no URL breadcrumb is written raw)', () => {
  const sites = callSites();

  it('writes breadcrumbs only from the known call sites', () => {
    expect([...sites.keys()].sort()).toEqual([
      // UI-interaction crumbs forwarded from the DOM source: no URL in them (asserted below)
      'browser/src/launch.ts',
      // carries a navigation URL: must sanitize it (asserted below)
      'nextjs/src/client.ts',
      // UI crumbs again, plus the page's own addBreadcrumb forwarded to native (application data, not a location)
      'webview/src/launch.ts',
    ]);
  });

  it('the Next.js navigation breadcrumb sanitizes the href before it reaches addBreadcrumb', () => {
    const text = sites.get('nextjs/src/client.ts') ?? '';
    expect(text).toContain("import { sanitizeLocationUrl } from '@bugsee/protocol'");
    const sanitized = text.indexOf('sanitizeLocationUrl(href)');
    expect(sanitized).toBeGreaterThan(-1);
    expect(sanitized).toBeLessThan(text.indexOf('client.addBreadcrumb('));
    // and the raw parameter is not used inside the call
    const call = text.slice(text.indexOf('client.addBreadcrumb('));
    expect(call.slice(0, call.indexOf('});'))).not.toMatch(/message: href|href,|href }/);
  });

  it('the UI breadcrumb source (the only other breadcrumb producer) reads no URL or location', () => {
    const ui = readFileSync(join(packages, 'browser/src/ui-breadcrumb-source.ts'), 'utf8');
    expect(ui).not.toMatch(/\bhref\b|location\.|\.url\b/);
  });
});
