import { type AdapterClientOptions, recordRenderSpan } from '@bugsee/web-adapter';
import {
  type ComponentType,
  createElement,
  Profiler,
  type ReactElement,
  type ReactNode,
} from 'react';

// React render-span profiling (frontend-adapters depth pass D4). `<BugseeProfiler id>` wraps a subtree in
// React's built-in `<Profiler>` and records a `ui.render` child span on the active transaction for each
// commit — component render performance (mount/update durations) the foundation can't otherwise see. The
// recording core (`recordReactRenderSpan`) is React-FREE + injection-tested; the component is a thin shell.
// A no-op when the SDK / performance ext / an active transaction is absent.
//
// ⚠ PRODUCTION: React DISABLES `<Profiler>` in a standard production build — `onRender` is never called, so
// this component records ZERO spans in the build customers actually ship. That is React's behaviour, not
// something this SDK can switch on: it depends on which `react-dom` the APP bundles. A developer wires this,
// sees spans in development, ships, and gets silence — which is why it is called out here, on the props, and
// on the HOC rather than left to be discovered (Wave 4.6).
//
// Two supported ways to get production render spans:
//   1. Bundle React's profiling build — alias `react-dom` to `react-dom/profiling` (and
//      `scheduler/tracing-profiling`) in your bundler. `<BugseeProfiler>` then works unchanged, at React's
//      documented profiling overhead.
//   2. Call `recordReactRenderSpan(profile, options)` yourself from any timing you already collect. It is
//      React-free and takes plain numbers, so it needs no Profiler and no special build.

const ATTR_BASE_DURATION = 'ui.render_base_duration_ms';

/** React's `<Profiler onRender>` payload (the timing of one commit). `startTime`/`commitTime` are
 *  `performance.now()`-relative; epoch = `timeOrigin + …`. */
export interface ReactRenderProfile {
  id: string;
  phase: string;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

export interface RecordRenderOptions extends AdapterClientOptions {
  /** `performance.timeOrigin` (injectable for tests). Default the real global. */
  timeOrigin?: number;
}

const realTimeOrigin = (): number =>
  (globalThis as { performance?: { timeOrigin?: number } }).performance?.timeOrigin ?? 0;

/** Record a `ui.render` child span on the active transaction for one React commit. A no-op when there is no
 *  active transaction (the render is not part of a captured trace). */
export function recordReactRenderSpan(
  profile: ReactRenderProfile,
  options: RecordRenderOptions = {},
): void {
  const timeOrigin = options.timeOrigin ?? realTimeOrigin();
  // React reports `actualDuration` (the render-phase work) as the duration — distinct from the span extent
  // (startTime→commitTime, which includes the commit gap) — so pass it explicitly. `baseDuration` is React-
  // specific extra. The shared recorder handles the active-transaction lookup + the `ui.render` op/attrs.
  recordRenderSpan(
    {
      name: profile.id,
      startTimestampMs: timeOrigin + profile.startTime,
      endTimestampMs: timeOrigin + profile.commitTime,
      phase: profile.phase,
      durationMs: profile.actualDuration,
      attributes: { [ATTR_BASE_DURATION]: profile.baseDuration },
    },
    { getClient: options.getClient },
  );
}

export interface BugseeProfilerProps extends RecordRenderOptions {
  /** The Profiler id — the label for the recorded `ui.render` spans. NOTE: a standard production React
   *  build never calls `onRender`, so no span carries this id in a shipped app — see the file header. */
  id: string;
  children?: ReactNode;
}

/**
 * Wrap a subtree in a React `<Profiler>` that records a `ui.render` span per commit.
 *
 * ⚠ Records NOTHING in a standard production React build — React disables `<Profiler>` there and never
 * calls `onRender`. Bundle `react-dom/profiling`, or call {@link recordReactRenderSpan} directly, to get
 * render spans from a shipped app. See the file header.
 */
export function BugseeProfiler(props: BugseeProfilerProps): ReactElement {
  const { id, children, ...options } = props;
  return createElement(
    Profiler,
    {
      id,
      onRender: (
        profilerId: string,
        phase: string,
        actualDuration: number,
        baseDuration: number,
        startTime: number,
        commitTime: number,
      ) =>
        recordReactRenderSpan(
          { id: profilerId, phase, actualDuration, baseDuration, startTime, commitTime },
          options,
        ),
    },
    children,
  );
}

/** HOC form: profile a component's renders. The Profiler id defaults to the component's name.
 *
 *  ⚠ Same production caveat as {@link BugseeProfiler}: a standard production React build never calls
 *  `onRender`, so this records nothing in a shipped app. See the file header. */
export function withBugseeProfiler<P extends object>(
  Wrapped: ComponentType<P>,
  id?: string,
  options: RecordRenderOptions = {},
): ComponentType<P> {
  // `||` (not `??`) for the name fallbacks: an anonymous component has an empty-string `name`, not nullish.
  const profilerId = id ?? (Wrapped.displayName || Wrapped.name || 'Component');
  const Profiled = (props: P): ReactNode =>
    createElement(BugseeProfiler, { id: profilerId, ...options }, createElement(Wrapped, props));
  Profiled.displayName = `withBugseeProfiler(${profilerId})`;
  return Profiled;
}
