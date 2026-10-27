import { readdirSync, readFileSync, statSync } from 'node:fs';
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

/**
 * String literals in `source` that spell a name in `names`, outside the contexts where such a string is not a wire name
 * (type positions, module specifiers, comparisons and `case` labels, tracker stage keys, a producer's own diagnostic id `readonly name = '…'`), plus
 * template literals whose static head is a prefix shared by several names (`power_${state}` builds wire names by string
 * concatenation, which no search for a literal could ever find).
 */
export function literalOffenders(source: string, names: ReadonlySet<string>): Offender[] {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const found: Offender[] = [];
  const at = (n: ts.Node): number => file.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const prefixes = new Set<string>();
  for (const name of names) {
    for (let i = 4; i < name.length; i++) if (name[i] === '_') prefixes.add(name.slice(0, i + 1));
  }
  const sharedPrefix = (head: string): boolean => {
    if (!prefixes.has(head)) return false;
    return [...names].filter((n) => n.startsWith(head)).length >= 2;
  };
  const visit = (n: ts.Node): void => {
    if (isStringish(n) && names.has(n.text) && !exempt(n)) {
      found.push({ line: at(n), text: n.text, why: 'registered wire name spelled as a literal' });
    }
    if (ts.isTemplateExpression(n) && sharedPrefix(n.head.text)) {
      found.push({
        line: at(n),
        text: n.head.text,
        why: 'wire name built by string concatenation',
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return found;
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
const NOT_PRODUCT = /\.(test|test-d)\.ts$|\.d\.ts$/;
/** A file is producer code when it builds trace producers, system-event sources, or the host-owned trace list. */
const PRODUCER = /\bTraceProducerBase\b|\bSystemEvent\b|\bhostOwnedTraces\b/;

/** The product source files (`packages/<pkg>/src/**`) that write or route system trace/event names (directory order). */
export function discoverProducerFiles(packagesDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (
        entry.endsWith('.ts') &&
        !NOT_PRODUCT.test(entry) &&
        PRODUCER.test(readFileSync(full, 'utf8'))
      ) {
        out.push(full);
      }
    }
  };
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    // the registry itself (protocol) and the contract types that merely MENTION the producer vocabulary are not producers
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
