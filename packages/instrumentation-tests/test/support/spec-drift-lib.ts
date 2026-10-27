import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// Source scanning for the spec-drift guard (spec-drift.test.ts). Pure functions over source text, so the probes in the
// test can prove the scanner catches what it claims to catch.

/** Call targets whose string arguments are TRACKER keys (stages), not wire names: `tracker.on('orientation', …)`. */
const TRACKER_METHODS = new Set(['on', 'off', 'once', 'current', 'onAny']);

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

export interface Offender {
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

const isStringish = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/** A prefix/suffix of a name must be at least this long to count as "the start/end of a family of names". */
const MIN_PREFIX = 5; // `power_`, `display_`, `process_` ... (`ram_` is too common a word)
const MIN_SUFFIX = 6; // `_changed`, `_started` ... (`_ms`, `_s`, `_free` are units and common words)

/**
 * String literals in `source` that spell a name in `names`, outside the contexts where such a string is not a wire name
 * (type positions, module specifiers, comparisons and `case` labels, tracker stage keys, a producer's own diagnostic id
 * `readonly name = '…'`), a name quoted inside a longer string (`'"name":"capture","value"'`), and every way of
 * ASSEMBLING a name that no search for a literal could find: a template (`power_${state}`, `${kind}_changed`), `+`
 * (`'power_' + state`) and `['power', s].join('_')`, when the fixed part is the start or the end of several names.
 */
export function literalOffenders(source: string, names: ReadonlySet<string>): Offender[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const found: Offender[] = [];
  const at = (n: ts.Node): number => file.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const prefixes = new Set<string>();
  const suffixes = new Set<string>();
  for (const name of names) {
    for (let i = 1; i < name.length; i++) {
      if (name[i] !== '_') continue;
      if (i + 1 >= MIN_PREFIX) prefixes.add(name.slice(0, i + 1));
      if (name.length - i >= MIN_SUFFIX) suffixes.add(name.slice(i));
    }
  }
  const sharedPrefix = (head: string): boolean =>
    prefixes.has(head) && [...names].filter((n) => n.startsWith(head)).length >= 2;
  const sharedSuffix = (tail: string): boolean =>
    suffixes.has(tail) && [...names].filter((n) => n.endsWith(tail)).length >= 2;
  const flag = (n: ts.Node, text: string, why: string): void => {
    found.push({ line: at(n), text, why });
  };
  const visit = (n: ts.Node): void => {
    if (isStringish(n) && !exempt(n)) {
      if (names.has(n.text)) flag(n, n.text, 'wire name spelled as a literal');
      else if ([...names].some((name) => n.text.includes(`"${name}"`))) {
        flag(n, n.text, 'wire name quoted inside a string');
      }
    }
    if (ts.isTemplateExpression(n)) {
      const tail = n.templateSpans[n.templateSpans.length - 1]?.literal.text ?? '';
      if (sharedPrefix(n.head.text)) flag(n, n.head.text, 'wire name built by a template');
      else if (sharedSuffix(tail)) flag(n, tail, 'wire name built by a template');
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      if (isStringish(n.left) && sharedPrefix(n.left.text)) {
        flag(n, n.left.text, 'wire name built by concatenation');
      } else if (isStringish(n.right) && sharedSuffix(n.right.text)) {
        flag(n, n.right.text, 'wire name built by concatenation');
      }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'join' &&
      ts.isArrayLiteralExpression(n.expression.expression)
    ) {
      const first = n.expression.expression.elements[0];
      const separator = n.arguments[0];
      if (
        first !== undefined &&
        isStringish(first) &&
        separator !== undefined &&
        isStringish(separator) &&
        separator.text === '_' &&
        sharedPrefix(`${first.text}_`)
      ) {
        flag(n, first.text, 'wire name built by join');
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return found;
}

/** `TraceName[key]` / `EventName[key]` with a computed key: it reaches a name the reference check never sees. */
export function dynamicRegistryLookups(source: string): Array<{ line: number; text: string }> {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isElementAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      (n.expression.text === 'TraceName' || n.expression.text === 'EventName') &&
      !isStringish(n.argumentExpression)
    ) {
      const line = file.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      out.push({ line, text: n.getText(file) });
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
}

function exempt(n: ts.Node): boolean {
  const p = n.parent;
  if (ts.isLiteralTypeNode(p) || ts.isImportDeclaration(p) || ts.isExportDeclaration(p))
    return true;
  // READING a string is not WRITING a wire name: `command === 'resume'` in a control channel shares a word with the
  // `resume` event but never reaches the system streams. Producers write names; they do not compare against them.
  if (ts.isBinaryExpression(p) && COMPARISONS.has(p.operatorToken.kind)) return true;
  if (ts.isCaseClause(p)) return true;
  if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression)) {
    return TRACKER_METHODS.has(p.expression.name.text);
  }
  return ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name) && p.name.text === 'name';
}

/** Names reached through the registry: `TraceName.X` / `EventName.X` (any case of access) in `source`. */
export function registryReferences(source: string): { traces: Set<string>; events: Set<string> } {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const traces = new Set<string>();
  const events = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      if (n.expression.text === 'TraceName') traces.add(n.name.text);
      if (n.expression.text === 'EventName') events.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return { traces, events };
}

export type EmitStyle = 'emit' | 'emitIfChanged';

/** How a producer sends a trace: `emit` (sampled, never refreshed) or `emitIfChanged` (held, re-recorded). */
const EMIT_CALLS: Readonly<Record<string, EmitStyle>> = {
  emit: 'emit',
  emitIfChanged: 'emitIfChanged',
  // the browser battery producer's helper for the two time traces: it forwards to `emit`
  publishTime: 'emit',
};

/**
 * For every `TraceName.X` that is the first argument of a producer emit call in `source`, the style it is sent with.
 * Held-ness is a property of the call (`emitIfChanged` marks the value for the provider's refresh), so this ties the
 * spec's held column to the code.
 */
export function traceEmitStyles(source: string): Map<string, Set<EmitStyle>> {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const out = new Map<string, Set<EmitStyle>>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const style = EMIT_CALLS[n.expression.name.text.replace(/^#/, '')];
      const first = n.arguments[0];
      if (
        style !== undefined &&
        first !== undefined &&
        ts.isPropertyAccessExpression(first) &&
        ts.isIdentifier(first.expression) &&
        first.expression.text === 'TraceName'
      ) {
        const styles = out.get(first.name.text) ?? new Set<EmitStyle>();
        styles.add(style);
        out.set(first.name.text, styles);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo']);
const NOT_PRODUCT = /\.(test|test-d)\.tsx?$|\.d\.ts$/;

/**
 * Every product source file (`packages/<pkg>/src/**`, .ts/.tsx) except the registry's own package. A producer is
 * recognised by living in the product tree, never by mentioning a keyword: a file that is only a list of names has none.
 */
export function discoverSourceFiles(packagesDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !NOT_PRODUCT.test(entry)) out.push(full);
    }
  };
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    // the registry itself (protocol) and this harness are not product code
    if (pkg !== 'protocol' && pkg !== 'instrumentation-tests' && existsDir(src)) walk(src);
  }
  return out.map((f) => relative(packagesDir, f));
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
