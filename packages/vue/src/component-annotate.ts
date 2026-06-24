import { COMPONENT_ATTRIBUTE } from '@bugsee/browser';
import { vueComponentName } from './component-name';

// @bugsee/vue COMPONENT ATTRIBUTION (frontend-adapters depth pass — the Vue emit side of the shared D2/D3
// component-attribution mechanism). A Vue global mixin stamps every component's root DOM element with
// `data-bugsee-component="<ComponentName>"`, so the @bugsee/browser runtime can attribute an interaction /
// error to the COMPONENT that rendered the target (its nearest annotated ancestor) — not just a DOM selector.
// Vue's runtime mixin is the per-framework counterpart to React's BUILD-time babel plugin: no compiler step,
// no `vue` import (STRUCTURAL PEER, version-agnostic). The attribute string is imported from @bugsee/browser
// so the emit + read sides share ONE constant. Observe-only + best-effort + idempotent: a nameless /
// fragment-root / hostile component is silently skipped and can never disrupt the app. Register once after
// `createApp(...)`: `app.mixin(createBugseeVueComponentMixin())`.

/** Minimal Vue public-instance surface the mixin reads (structural — no `vue` import). `$el` is the
 *  component's root node (an Element for a single-root component; a comment/text anchor for a fragment root). */
export interface VueComponentInstanceLike {
  $el?: unknown;
  $options?: { name?: unknown };
  $?: { type?: { name?: unknown; displayName?: unknown; __name?: unknown } };
}

/** The Vue mixin shape this factory returns (mount + update lifecycle hooks). */
export interface BugseeVueComponentMixin {
  mounted(this: VueComponentInstanceLike): void;
  updated(this: VueComponentInstanceLike): void;
}

/** The element surface the mixin writes — a real DOM Element or a test fake. A fragment/text root lacks
 *  `setAttribute`, which is how we detect "no element to stamp". */
interface ElementLike {
  setAttribute?: (name: string, value: string) => void;
  getAttribute?: (name: string) => string | null;
}

/** Stamp a component's root element with its component name. Best-effort + idempotent (skips a redundant
 *  write when the element already holds this name — keeps the per-update footprint minimal). */
function annotate(instance: VueComponentInstanceLike): void {
  const name = vueComponentName(instance);
  if (name === undefined) return; // anonymous / nameless component — nothing meaningful to attribute
  const el = instance.$el as ElementLike | null | undefined;
  if (el === null || el === undefined || typeof el.setAttribute !== 'function') return; // fragment/text root
  try {
    if (el.getAttribute?.(COMPONENT_ATTRIBUTE) === name) return; // already stamped with this name — skip
    el.setAttribute(COMPONENT_ATTRIBUTE, name);
  } catch {
    // observe-only: a hostile / throwing setAttribute must never disrupt the host app
  }
}

/** A Vue global mixin that stamps each component's root DOM element with `data-bugsee-component`, enabling
 *  component-level attribution of captured interactions/errors. Register once: `app.mixin(...)`. */
export function createBugseeVueComponentMixin(): BugseeVueComponentMixin {
  return {
    mounted(this: VueComponentInstanceLike): void {
      annotate(this);
    },
    updated(this: VueComponentInstanceLike): void {
      annotate(this);
    },
  };
}
