import {
  type AdapterClientOptions,
  recordRenderSpan,
  resolveTimeOrigin,
} from '@bugsee/web-adapter';
import {
  type ComponentType,
  createElement,
  Fragment,
  Profiler,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useRef,
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
/** Marks a span measured by the component's own post-commit fallback rather than by React's Profiler. The
 *  fallback spans render-start → post-commit, which INCLUDES commit work React excludes from
 *  `actualDuration`, so a consumer comparing the two must be able to tell them apart. */
const ATTR_SOURCE = 'ui.render_source';

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
  /** Who measured this commit. `'fallback'` marks the component's own post-commit measurement, used when
   *  React's Profiler is inert (a production build). Omitted when React reported the timings itself. */
  source?: 'fallback';
}

const now = (): number =>
  (globalThis as { performance?: { now?: () => number } }).performance?.now?.() ?? 0;

// Not `.performance?.timeOrigin ?? 0`: `??` only replaces `null`/`undefined`, so a NaN (or, via an
// unchecked cast, a non-number) timeOrigin would sail through and poison every wire timestamp below into
// NaN. And a literal 0 is no better — no spec-compliant host anchors its clock at the Unix epoch, so it
// would just stamp spans ~1970, decades before the real-epoch transaction they nest inside. `Number.isFinite`
// screens all of that in `resolveTimeOrigin` (@bugsee/util, via the web-adapter re-export), which also
// reconstructs a usable-if-imprecise origin from a live wall-clock reading when the host's is unusable.
const realTimeOrigin = (): number =>
  resolveTimeOrigin(
    (globalThis as { performance?: { now?: () => unknown; timeOrigin?: unknown } }).performance,
  );

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
      attributes: {
        [ATTR_BASE_DURATION]: profile.baseDuration,
        ...(options.source !== undefined ? { [ATTR_SOURCE]: options.source } : {}),
      },
    },
    { getClient: options.getClient },
  );
}

export interface BugseeProfilerProps extends RecordRenderOptions {
  /** The Profiler id — the label for the recorded `ui.render` spans. NOTE: a standard production React
   *  build never calls `onRender`, so no span carries this id in a shipped app — see the file header. */
  id: string;
  children?: ReactNode;
  /** TEST-ONLY: render without React's `<Profiler>`, reproducing a production build (children render,
   *  `onRender` never fires). Not part of the supported API. */
  __profilerInert?: boolean;
}

/**
 * Wrap a subtree in a React `<Profiler>` that records a `ui.render` span per commit.
 *
 * ⚠ Records NOTHING in a standard production React build — React disables `<Profiler>` there and never
 * calls `onRender`. Bundle `react-dom/profiling`, or call {@link recordReactRenderSpan} directly, to get
 * render spans from a shipped app. See the file header.
 */
export function BugseeProfiler(props: BugseeProfilerProps): ReactElement {
  const { id, children, __profilerInert, ...options } = props;
  // React's Profiler is inert in a production build: children render, `onRender` NEVER fires. So the
  // component measures the commit itself and reports only when React did not — self-detecting, with no
  // build flag to read and nothing to configure. `reportedRef` is set by `onRender` and consumed by the
  // layout effect that runs immediately after the same commit.
  const reportedRef = useRef(false);
  const startRef = useRef(0);
  const mountedRef = useRef(false);
  startRef.current = now(); // render body — the start of THIS commit's work

  useLayoutEffect(() => {
    const wasMounted = mountedRef.current;
    mountedRef.current = true;
    if (reportedRef.current) {
      reportedRef.current = false; // React already reported this commit, with better numbers
      return;
    }
    const commitTime = now();
    const startTime = startRef.current;
    recordReactRenderSpan(
      {
        id,
        phase: wasMounted ? 'update' : 'mount',
        actualDuration: commitTime - startTime,
        // React's `baseDuration` (cost without memoization) is an internal it does not expose here.
        // Reporting the measured duration keeps the field meaningful rather than inventing a number.
        baseDuration: commitTime - startTime,
        startTime,
        commitTime,
      },
      { ...options, source: 'fallback' },
    );
  });

  const onRender = (
    profilerId: string,
    phase: string,
    actualDuration: number,
    baseDuration: number,
    startTime: number,
    commitTime: number,
  ): void => {
    reportedRef.current = true;
    recordReactRenderSpan(
      { id: profilerId, phase, actualDuration, baseDuration, startTime, commitTime },
      options,
    );
  };

  // `__profilerInert` renders WITHOUT React's Profiler, reproducing a production build exactly (children
  // render, onRender never fires). Test-only, and the only way to exercise the production path in a suite
  // that necessarily runs a development React.
  return __profilerInert === true
    ? createElement(Fragment, null, children)
    : createElement(Profiler, { id, onRender }, children);
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
