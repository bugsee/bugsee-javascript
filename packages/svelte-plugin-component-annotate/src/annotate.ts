// The component-annotation transform: walk a parsed Svelte markup AST, find every HOST element, and splice a
// `data-bugsee-component="<Name>"` attribute onto each opening tag in the original source. Pure + version-
// agnostic: `parse` is INJECTED (the real `svelte/compiler` parse in production, a fake AST in unit tests),
// and the walker handles BOTH AST shapes — legacy (`html` / `children` / type `Element`, Svelte ≤4 and
// Svelte 5's default) and modern (`fragment` / `nodes` / type `RegularElement`, Svelte ≥6 / `modern:true`).
// Dependency-free: insertions are applied highest-offset-first so earlier offsets never shift (no
// magic-string), and inline on the tag line so source line numbers are preserved. Observe-only at build time:
// a parse failure returns undefined (Svelte's own compiler then reports the real syntax error).

// MUST equal `COMPONENT_ATTRIBUTE` in @bugsee/browser (the runtime READ side). Hardcoded — like the babel
// plugin — to keep this build tool free of any @bugsee runtime dependency.
const ATTRIBUTE = 'data-bugsee-component';

// Element node types across Svelte versions. Components (`InlineComponent` / `Component`, PascalCase) are NOT
// here — they are not DOM elements, so they get no attribute (but we still descend into their slot children).
const ELEMENT_TYPES = new Set(['Element', 'RegularElement']);
const isHostTag = (name: string): boolean => /^[a-z]/.test(name); // lowercase tag = a DOM/host element

type AnyNode = Record<string, unknown>;

interface HostElement {
  start: number;
  name: string;
}

function asHostElement(node: AnyNode): HostElement | undefined {
  if (
    !ELEMENT_TYPES.has(node.type as string) ||
    typeof node.name !== 'string' ||
    !isHostTag(node.name) ||
    typeof node.start !== 'number'
  ) {
    return undefined;
  }
  return { start: node.start, name: node.name };
}

function isAnnotated(node: AnyNode): boolean {
  return (
    Array.isArray(node.attributes) &&
    node.attributes.some(
      (a) =>
        a !== null &&
        typeof a === 'object' &&
        (a as AnyNode).type === 'Attribute' &&
        (a as AnyNode).name === ATTRIBUTE,
    )
  );
}

/** Depth-first collect every not-yet-annotated host element, descending through arrays, blocks, components
 *  and slot content. A `seen` identity set makes a cyclic AST (parent back-references) safe. */
function collectHostElements(node: unknown, out: HostElement[], seen: Set<object>): void {
  if (node === null || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectHostElements(item, out, seen);
    return;
  }
  const n = node as AnyNode;
  const host = asHostElement(n);
  if (host !== undefined && !isAnnotated(n)) out.push(host);
  for (const key of Object.keys(n)) collectHostElements(n[key], out, seen);
}

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Annotate every host element in `content` with `data-bugsee-component="componentName"`. Returns the
 *  transformed source, or undefined when there is nothing to do (parse error / no markup root / no host
 *  elements) so the caller can leave the file untouched. */
export function annotateMarkup(
  content: string,
  componentName: string,
  parse: (source: string) => unknown,
): string | undefined {
  let ast: unknown;
  try {
    ast = parse(content);
  } catch {
    return undefined; // a genuine syntax error — defer to Svelte's own compiler for the diagnostic
  }
  // The markup root differs by Svelte version: `fragment` (modern) / `html` (legacy). A missing root or a
  // non-object value (parse returned null / a primitive) simply yields no host elements in the walker below.
  const root = ast as { fragment?: unknown; html?: unknown } | null;
  const markup = root?.fragment ?? root?.html;

  const elements: HostElement[] = [];
  collectHostElements(markup, elements, new Set());
  if (elements.length === 0) return undefined;

  const attr = ` ${ATTRIBUTE}="${escapeAttr(componentName)}"`;
  // Insert just after each tag name (`<` + name). Highest offset first so earlier offsets stay valid.
  const offsets = elements.map((e) => e.start + 1 + e.name.length).sort((a, b) => b - a);
  let code = content;
  for (const at of offsets) code = `${code.slice(0, at)}${attr}${code.slice(at)}`;
  return code;
}
