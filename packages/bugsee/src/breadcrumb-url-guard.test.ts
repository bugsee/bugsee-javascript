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
const RAW_ADDRESS =
  /^(href|url|uri|newurl|oldurl|pathname|location|path|aspath|to|from|search|hash|baseuri|destination|referrer)$/i;

/** Whether a call's callee is `addBreadcrumb` in any form: `x.addBreadcrumb`, `x?.addBreadcrumb`, `x['addBreadcrumb']`, or a
 *  destructured / imported bare `addBreadcrumb(...)`. */
function isBreadcrumbCallee(callee: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'addBreadcrumb';
  if (ts.isElementAccessExpression(callee)) {
    return (
      ts.isStringLiteralLike(callee.argumentExpression) &&
      callee.argumentExpression.text === 'addBreadcrumb'
    );
  }
  return ts.isIdentifier(callee) && callee.text === 'addBreadcrumb';
}

/**
 * Every mention of `addBreadcrumb` that is NOT a direct call and NOT a declaration of it: `x.addBreadcrumb.call(...)`,
 * `.apply`, `.bind`, `(0, x.addBreadcrumb)(...)`, `const ab = x.addBreadcrumb`, `const { addBreadcrumb } = x`, a string
 * that names it. Such a reference can be called later with arguments this guard never sees, so any one outside the
 * allow-list below FAILS the guard (fail closed). Returns a short description of each.
 */
export function indirectBreadcrumbReferences(text: string): string[] {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const isDirectCallee = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) return true; // `addBreadcrumb(...)`
    return (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent // `x.addBreadcrumb(...)`, `x['addBreadcrumb'](...)`
    );
  };
  const visit = (node: ts.Node): void => {
    const named =
      (ts.isIdentifier(node) && node.text === 'addBreadcrumb') ||
      (ts.isStringLiteralLike(node) && node.text === 'addBreadcrumb');
    if (named) {
      const parent = node.parent;
      const declaration =
        (ts.isMethodDeclaration(parent) ||
          ts.isMethodSignature(parent) ||
          ts.isPropertyAssignment(parent)) &&
        parent.name === node;
      if (!declaration && !isDirectCallee(node)) {
        found.push(
          ts.isStringLiteralLike(node) ? 'string' : `reference in ${ts.SyntaxKind[parent.kind]}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The raw-address identifiers used inside the arguments of every `.addBreadcrumb(...)` call in `text`. */
export function rawAddressesInBreadcrumbCalls(text: string): string[] {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isBreadcrumbCallee(node.expression)) {
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
    ['an element-access callee', "client['addBreadcrumb']({ message: href });"],
    ['a destructured call', 'addBreadcrumb({ message: href });'],
    ['an optional call', 'client?.addBreadcrumb?.({ message: href });'],
    ['an event URL', 'client.addBreadcrumb({ message: event.newURL });'],
    ['a router destination', 'client.addBreadcrumb({ message: to });'],
    ['a router asPath', 'client.addBreadcrumb({ data: { asPath } });'],
    ['a hash', 'client.addBreadcrumb({ message: hash });'],
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

/** Whether `text` calls `.addBreadcrumb` in ANY syntactic form (`x.addBreadcrumb(`, `x.addBreadcrumb (`, `x?.addBreadcrumb?.(`,
 *  `x['addBreadcrumb'](`): found by the AST, not by a text pattern that a spelling variant would slip past. */
export function hasBreadcrumbCall(text: string): boolean {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isBreadcrumbCallee(node.expression)) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the guard flags every indirect reference to addBreadcrumb', () => {
  it.each([
    'client.addBreadcrumb.call(client, { message: href });',
    'client.addBreadcrumb.apply(client, [{ message: href }]);',
    'const f = client.addBreadcrumb.bind(client);',
    '(0, client.addBreadcrumb)({ message: href });',
    'const ab = client.addBreadcrumb; ab({ message: href });',
    'const { addBreadcrumb } = client;',
    "const names = ['addBreadcrumb'];",
    'register(client.addBreadcrumb);',
  ])('flags %s', (code) => {
    expect(indirectBreadcrumbReferences(code).length).toBeGreaterThan(0);
  });

  it('does not flag a direct call or a declaration of the method', () => {
    expect(
      indirectBreadcrumbReferences(
        "client.addBreadcrumb({});\nclient['addBreadcrumb']({});\naddBreadcrumb({});\ninterface C { addBreadcrumb(b: B): void }\nconst o = { addBreadcrumb(b: B) {}, x: 1 };\nconst p = { addBreadcrumb: noop };",
      ),
    ).toEqual([]);
  });
});

describe('the guard discovers a breadcrumb call in every syntactic form', () => {
  it.each([
    'x.addBreadcrumb({});',
    'x.addBreadcrumb ({});',
    'x?.addBreadcrumb?.({});',
    "x['addBreadcrumb']({});",
    'this.client.addBreadcrumb({});',
    'addBreadcrumb({});',
  ])('finds %s', (code) => {
    expect(hasBreadcrumbCall(code)).toBe(true);
  });
  it('does not flag a mention in a comment or an unrelated call', () => {
    expect(hasBreadcrumbCall('// x.addBreadcrumb({})\nother.add({});')).toBe(false);
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
      if (hasBreadcrumbCall(text)) found.set(relative(packages, file), text);
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

  it('no single-file component (.vue/.svelte/.astro) writes a breadcrumb at all (they cannot be parsed here)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (
          /\.(vue|svelte|astro)$/.test(name) &&
          readFileSync(full, 'utf8').includes('.addBreadcrumb(')
        ) {
          offenders.push(relative(packages, full));
        }
      }
    };
    for (const pkg of readdirSync(packages)) {
      try {
        walk(join(packages, pkg, 'src'));
      } catch {
        // a package without a src directory
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source references addBreadcrumb indirectly, except the one known string (fail closed)', () => {
    const indirect = new Map<string, string[]>();
    const scanned = new Map<string, string>();
    for (const pkg of readdirSync(packages)) {
      const src = join(packages, pkg, 'src');
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of sourceFiles(src)) {
        const text = readFileSync(file, 'utf8');
        if (!text.includes('addBreadcrumb')) continue;
        scanned.set(relative(packages, file), text);
      }
    }
    for (const [file, text] of scanned) {
      const found = indirectBreadcrumbReferences(text);
      if (found.length > 0) indirect.set(file, found);
    }
    // The WebView lists the names of the methods it forwards to native (a page-facing allow-list of method NAMES, not a call).
    expect(Object.fromEntries(indirect)).toEqual({ 'webview/src/launch.ts': ['string'] });
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
