// Component-name attribution (frontend-adapters depth pass D2). A build plugin (@bugsee/babel-plugin-
// component-annotate, D3) stamps each host DOM element with `data-bugsee-component="<ComponentName>"` — the
// name of the framework component that rendered it, preserved through minification (the plugin emits the
// literal name). At capture time we resolve the nearest annotated ancestor of an interaction/input target,
// so a click/error attributes to a COMPONENT name, not just a DOM selector. Foundation-level (benefits any
// app that annotates, regardless of which framework adapter is installed). Observe-only: a hostile/throwing
// `closest` or a non-element target can never disrupt the app.

/** The DOM attribute the build plugin emits + this resolver reads. */
export const COMPONENT_ATTRIBUTE = 'data-bugsee-component';

interface ClosestLike {
  closest?: (selector: string) => { getAttribute?: (name: string) => string | null } | null;
}

/** The nearest annotated component name for a target element (self or an ancestor), or undefined when the
 *  target is not an element / nothing in its ancestry is annotated. */
export function componentNameFromElement(node: unknown): string | undefined {
  const el = (node ?? undefined) as ClosestLike | undefined;
  if (el === undefined || typeof el.closest !== 'function') return undefined;
  try {
    const match = el.closest(`[${COMPONENT_ATTRIBUTE}]`);
    const name = match?.getAttribute?.(COMPONENT_ATTRIBUTE);
    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch {
    return undefined; // a hostile getter / invalid selector must never disrupt capture
  }
}
