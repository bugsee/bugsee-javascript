import { type AdapterMechanism, type ReportErrorOptions, reportError } from '@bugsee/web-adapter';

// The @bugsee/vue ERROR SEAM (frontend-adapters §7 fan-out — the F6-thin pattern for Vue 3). Hooks Vue's
// global `app.config.errorHandler(err, instance, info)` and reports the error to the launched Bugsee client.
// Vue's error context is THIN compared to React's component stack — a short `info` string (where it threw:
// a lifecycle hook / render / setup) + the failing component's name — so we attach them as searchable LABELS
// rather than a cause-linked stack. A STRUCTURAL PEER over the Vue app/instance shapes (no `vue` import) →
// version-agnostic + unit-testable. Runtime-portable, React/Vue-free at the value level; a no-op when no SDK
// is launched. v1 = error + routing only (component-render profiling / deeper attribution is the shared
// depth pass).

/** Capture mechanism for a Vue error report (the `logException` mechanism vocabulary). */
export type VueErrorMechanism = AdapterMechanism;

/** The minimal Vue `App` surface we touch — structurally matches `createApp(...)`'s `app`. */
export interface VueAppLike {
  config: { errorHandler?: ((err: unknown, instance: unknown, info: string) => void) | undefined };
}

/** Options for the Vue error seam (client resolver + mechanism). */
export type VueErrorOptions = Omit<ReportErrorOptions, 'labels'>;

export interface ReportVueErrorOptions extends VueErrorOptions {
  /** Vue's error info string — where it threw (a lifecycle hook / `render function` / `setup function`). */
  info?: string;
  /** The failing component instance — its name is read structurally (no `vue` import). */
  instance?: unknown;
}

/** Best-effort component name from a Vue instance — mirrors Vue's own `getComponentName` precedence
 *  (explicit `name`, then a functional component's `displayName`, then the `<script setup>`-inferred
 *  `__name`): options-API `$options.name`, else `$.type.name`/`$.type.displayName`/`$.type.__name`.
 *  Returns undefined for a non-object / nameless instance (e.g. an anonymous functional component). */
function componentName(instance: unknown): string | undefined {
  if (instance === null || typeof instance !== 'object') return undefined;
  const i = instance as {
    $options?: { name?: unknown };
    $?: { type?: { name?: unknown; displayName?: unknown; __name?: unknown } };
  };
  const name = i.$options?.name ?? i.$?.type?.name ?? i.$?.type?.displayName ?? i.$?.type?.__name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/** Report a Vue error to the launched Bugsee client, labeled with the component name + Vue info. A no-op
 *  when no SDK is launched. */
export function reportVueError(error: unknown, options: ReportVueErrorOptions = {}): void {
  const labels: string[] = [];
  const name = componentName(options.instance);
  if (name !== undefined) labels.push(`vue.component:${name}`);
  if (options.info !== undefined && options.info !== '') labels.push(`vue.info:${options.info}`);
  reportError(error, { ...options, ...(labels.length > 0 ? { labels } : {}) });
}

/** Install Bugsee on a Vue app's global error handler, CHAINING any pre-existing handler (the app keeps its
 *  own). Call once after `createApp(...)`. */
export function installBugseeErrorHandler(app: VueAppLike, options: VueErrorOptions = {}): void {
  const previous = app.config.errorHandler;
  app.config.errorHandler = (err, instance, info) => {
    reportVueError(err, { ...options, info, instance });
    if (typeof previous === 'function') previous(err, instance, info); // preserve the app's own handler
  };
}
