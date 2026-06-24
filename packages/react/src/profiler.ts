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
  /** The Profiler id — the label for the recorded `ui.render` spans. */
  id: string;
  children?: ReactNode;
}

/** Wrap a subtree in a React `<Profiler>` that records a `ui.render` span per commit. */
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

/** HOC form: profile a component's renders. The Profiler id defaults to the component's name. */
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
