import { type AdapterClientOptions, recordRenderSpan } from '@bugsee/web-adapter';
import { vueComponentName } from './component-name';

// @bugsee/vue RENDER SPANS (frontend-adapters depth pass — the Vue counterpart to React's <Profiler>). A Vue
// global mixin times each component's render and records a `ui.render` child span on the active transaction:
// `beforeMount→mounted` (the initial mount) and `beforeUpdate→updated` (a re-render+patch). Vue's lifecycle
// makes these nest naturally — a parent's `mounted`/`updated` fires AFTER its children's, so a parent span
// temporally encloses its descendants. A STRUCTURAL PEER (no `vue` import — Vue calls the plain mixin object,
// `this` is the component public instance); per-instance start times live in a WeakMap (the app's instances
// are never mutated). OPT-IN + observe-only: register once after createApp —
// `app.mixin(createBugseeVueRenderMixin())` — and a no-op when no transaction is active / no SDK.

/** Minimal Vue public-instance surface read for the component name (structural — no `vue` import). */
export interface VueRenderInstanceLike {
  $options?: { name?: unknown };
  $?: { type?: { name?: unknown; displayName?: unknown; __name?: unknown } };
}

/** The Vue render mixin shape this factory returns (the mount + update lifecycle hook pairs). */
export interface BugseeVueRenderMixin {
  beforeMount(this: VueRenderInstanceLike): void;
  mounted(this: VueRenderInstanceLike): void;
  beforeUpdate(this: VueRenderInstanceLike): void;
  updated(this: VueRenderInstanceLike): void;
}

export interface VueRenderMixinOptions extends AdapterClientOptions {
  /** Skip renders faster than this many ms (span-volume control). Default 0 — record every mount/update. */
  minDurationMs?: number;
  /** Injectable epoch-ms clock. Default `performance.timeOrigin + performance.now()`. */
  now?: () => number;
}

const defaultNow = (): number => {
  const perf = (globalThis as { performance?: { now?: () => number; timeOrigin?: number } })
    .performance;
  return (perf?.timeOrigin ?? 0) + (perf?.now?.() ?? 0);
};

/** A Vue global mixin that records a `ui.render` span per component mount/update on the active transaction.
 *  Register once: `app.mixin(createBugseeVueRenderMixin())`. */
export function createBugseeVueRenderMixin(
  options: VueRenderMixinOptions = {},
): BugseeVueRenderMixin {
  const now = options.now ?? defaultNow;
  const minDurationMs = options.minDurationMs ?? 0;
  const starts = new WeakMap<object, number>();

  const begin = (instance: object): void => {
    starts.set(instance, now());
  };
  const end = (instance: VueRenderInstanceLike, phase: 'mount' | 'update'): void => {
    const start = starts.get(instance);
    if (start === undefined) return; // an after-hook with no matching begin (defensive)
    starts.delete(instance);
    try {
      const name = vueComponentName(instance);
      if (name === undefined) return; // anonymous component — nothing meaningful to attribute
      const endTimestampMs = now();
      if (endTimestampMs - start < minDurationMs) return; // below the volume threshold
      recordRenderSpan(
        { name, startTimestampMs: start, endTimestampMs, phase },
        { getClient: options.getClient },
      );
    } catch {
      // observe-only: a hostile component instance must never disrupt Vue's render lifecycle
    }
  };

  return {
    beforeMount(this: VueRenderInstanceLike): void {
      begin(this);
    },
    mounted(this: VueRenderInstanceLike): void {
      end(this, 'mount');
    },
    beforeUpdate(this: VueRenderInstanceLike): void {
      begin(this);
    },
    updated(this: VueRenderInstanceLike): void {
      end(this, 'update');
    },
  };
}
