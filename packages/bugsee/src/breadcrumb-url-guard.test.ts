import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// C21 guard: `client.addBreadcrumb` applies NO sanitizer (a breadcrumb is application data), so a package that writes a
// breadcrumb carrying a URL must sanitize that URL itself (`sanitizeLocationUrl`). The Next.js navigation breadcrumb
// once wrote the raw `href`. This test pins EVERY SDK-internal `.addBreadcrumb(` call site and classifies it, and it
// reads the call SEMANTICALLY (the TypeScript AST): any identifier inside the call's arguments that names a raw
// address (`href`, `url`, `pathname`, ...) is a finding, whatever the form (`message: href`, `String(href)`,
// `${href}`, a shorthand `{ href }`). A sanitized value must be bound to another name (`safeHref`) first.

const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Names that hold an UNSANITIZED address. A breadcrumb argument must not mention one. */
const RAW_ADDRESS = /^(href|url|uri|pathname|location|path|destination|referrer)$/i;

/** The raw-address identifiers used inside the arguments of every `.addBreadcrumb(...)` call in `text`. */
export function rawAddressesInBreadcrumbCalls(text: string): string[] {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'addBreadcrumb'
    ) {
      for (const argument of node.arguments) {
        const inspect = (inner: ts.Node): void => {
          if (ts.isIdentifier(inner) && RAW_ADDRESS.test(inner.text)) found.push(inner.text);
          // `{ href: safeHref }` names the PROPERTY `href`; only the value matters, so skip property names.
          if (ts.isPropertyAssignment(inner)) {
            inspect(inner.initializer);
            return;
          }
          ts.forEachChild(inner, inspect);
        };
        inspect(argument);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the guard itself detects every form of a raw address in a breadcrumb', () => {
  const bad: Array<[string, string]> = [
    ['a property value', 'client.addBreadcrumb({ message: href });'],
    ['a shorthand property', 'client.addBreadcrumb({ data: { href } });'],
    ['String()', 'client.addBreadcrumb({ message: String(href) });'],
    ['a template literal', ['client.addBreadcrumb({ message: `to $', '{href}` });'].join('')],
    ['concatenation', "client.addBreadcrumb({ message: 'to ' + url });"],
    ['a member access', 'client.addBreadcrumb({ message: location.pathname });'],
    ['a spread', 'client.addBreadcrumb({ ...url });'],
    ['a call result', 'this.client.addBreadcrumb(make(pathname));'],
  ];
  it.each(bad)('flags %s', (_name, code) => {
    expect(rawAddressesInBreadcrumbCalls(code).length).toBeGreaterThan(0);
  });

  it('accepts a sanitized value under another name, and a property that is merely NAMED href', () => {
    expect(
      rawAddressesInBreadcrumbCalls(
        'client.addBreadcrumb({ message: safeHref, data: { href: safeHref, navigationType } });',
      ),
    ).toEqual([]);
  });

  it('ignores calls that are not addBreadcrumb', () => {
    expect(rawAddressesInBreadcrumbCalls('other.log({ message: href });')).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|test-d)\.tsx?$/.test(name) ? [full] : [];
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
      // carries a navigation URL: sanitized before the call (asserted below)
      'nextjs/src/client.ts',
      // UI crumbs again, plus the page's own addBreadcrumb forwarded to native (application data, not a location)
      'webview/src/launch.ts',
    ]);
  });

  it('no call site mentions a raw address in its arguments', () => {
    for (const [file, text] of sites) {
      expect(rawAddressesInBreadcrumbCalls(text), file).toEqual([]);
    }
  });

  it('the Next.js navigation breadcrumb sanitizes the href with the location sanitizer', () => {
    const text = sites.get('nextjs/src/client.ts') ?? '';
    expect(text).toContain("import { sanitizeLocationUrl } from '@bugsee/protocol'");
    expect(text).toMatch(/const safeHref = sanitizeLocationUrl\(href\)/);
  });

  it('the UI breadcrumb source (the only other breadcrumb producer) reads no URL or location', () => {
    const ui = readFileSync(join(packages, 'browser/src/ui-breadcrumb-source.ts'), 'utf8');
    expect(ui).not.toMatch(/\bhref\b|location\.|\.url\b/);
  });
});
