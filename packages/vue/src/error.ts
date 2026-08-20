import {
  type AdapterMechanism,
  neverThrow,
  type ReportErrorOptions,
  reportError,
} from '@bugsee/web-adapter';
import { vueComponentName } from './component-name';

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
/**
 * The slice of Vue's `App` this seam touches — structural, so `vue` stays a peer rather than a
 * dependency.
 *
 * `instance` is `never`, not `unknown`. Vue types the real handler's instance as
 * `ComponentPublicInstance | null`, and under `strictFunctionTypes` a property holding a function is
 * checked CONTRAVARIANTLY — so a structural `instance: unknown` made a genuine `App` unassignable
 * here, and `installBugseeErrorHandler(createApp(…))` did not typecheck for any real user. It only
 * ever passed against this package's own test double. `never` accepts any instance type from either
 * direction, which is what a structural stand-in for someone else's callback needs.
 */
export interface VueAppLike {
  config: { errorHandler?: ((err: unknown, instance: never, info: string) => void) | undefined };
}

/** Options for the Vue error seam (client resolver + mechanism). */
export type VueErrorOptions = Omit<ReportErrorOptions, 'labels'>;

export interface ReportVueErrorOptions extends VueErrorOptions {
  /** Vue's error info string — where it threw (a lifecycle hook / `render function` / `setup function`). */
  info?: string;
  /** The failing component instance — its name is read structurally (no `vue` import). */
  instance?: unknown;
}

/** Report a Vue error to the launched Bugsee client, labeled with the component name + Vue info. A no-op
 *  when no SDK is launched. */
export function reportVueError(error: unknown, options: ReportVueErrorOptions = {}): void {
  const labels: string[] = [];
  const name = vueComponentName(options.instance);
  if (name !== undefined) labels.push(`vue.component:${name}`);
  if (options.info !== undefined && options.info !== '') labels.push(`vue.info:${options.info}`);
  reportError(error, { ...options, ...(labels.length > 0 ? { labels } : {}) });
}

/**
 * Vue's OWN default behaviour when no `app.config.errorHandler` is set, reproduced.
 *
 * Installing a handler REPLACES Vue's default. Without this, an app that had no handler of its own lost the
 * only thing that surfaces an uncaught error: measured on real vue 3.5.38, the production build went from 1
 * `console.error` to 0, and the dev build from a thrown `app.mount()` + a `[Vue warn]` to silence. Identical
 * to the Angular defect fixed in e17f389 — this is its sibling, one package over. Vue is a structural peer
 * here (never imported), so the default is reproduced rather than delegated to.
 */
const vueDefaultErrorHandler = (err: unknown): void => {
  console.error(err);
};

/** Install Bugsee on a Vue app's global error handler, CHAINING any pre-existing handler (the app keeps its
 *  own) or Vue's own default when there is none. Call once after `createApp(...)`. */
export function installBugseeErrorHandler(app: VueAppLike, options: VueErrorOptions = {}): void {
  const previous = app.config.errorHandler;
  app.config.errorHandler = (err, instance, info) => {
    // Contained (Wave 2.1): the component-name lookup and label building run here too, and a throw from any
    // of it would skip the app's own handler below — turning a recoverable error into an unrecoverable one
    // at exactly the moment the app needs its handler most.
    neverThrow(() => reportVueError(err, { ...options, info, instance }), options.onError);
    if (typeof previous === 'function') {
      // `instance` is `never` in the structural type (see VueAppLike); at runtime it is whatever Vue
      // handed us, and the app's own handler is the one that knows how to read it.
      (previous as (e: unknown, i: unknown, n: string) => void)(err, instance, info);
    } else {
      vueDefaultErrorHandler(err); // …and Vue's own when the app had none
    }
  };
}
