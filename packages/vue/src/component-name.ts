import { neverThrow } from '@bugsee/web-adapter';

// Best-effort component name from a Vue public instance — the SHARED resolver used by both the error seam
// (error.ts, as a `vue.component:` label) and the component-attribution mixin (component-annotate.ts, as the
// `data-bugsee-component` value). One source of truth so a component is named identically in both places.
// Approximates Vue's own `getComponentName`: explicit `$options.name`, then the resolved type's `name`,
// then `displayName` (Vue checks this only for FUNCTIONAL components — we fold it in as a general fallback,
// a superset that never yields a wrong name since explicit names win first), then the `<script setup>`-
// inferred `__name`. A STRUCTURAL PEER (no `vue` import) → version-agnostic. Undefined for a non-object /
// nameless instance.
export function vueComponentName(instance: unknown): string | undefined {
  // CONTAINED. Every read here is on a HOST-supplied component instance, and a getter on it can throw —
  // measured against a proxied instance. Callers use this for a label; failing to name a component must
  // never cost the report, let alone the app.
  return neverThrow(() => {
    if (instance === null || typeof instance !== 'object') return undefined;
    const i = instance as {
      $options?: { name?: unknown };
      $?: { type?: { name?: unknown; displayName?: unknown; __name?: unknown } };
    };
    const name = i.$options?.name ?? i.$?.type?.name ?? i.$?.type?.displayName ?? i.$?.type?.__name;
    return typeof name === 'string' && name !== '' ? name : undefined;
  });
}
