import { type AdapterClientOptions, getPerformanceApi } from '@bugsee/web-adapter';
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

const ATTR_PHASE = 'ui.render_phase';
const ATTR_DURATION = 'ui.render_duration_ms';
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
  const active = getPerformanceApi(options.getClient)?.getActiveSpan();
  if (active === undefined) return;
  const timeOrigin = options.timeOrigin ?? realTimeOrigin();
  active.recordChildSpan('ui.render', {
    startTimestampMs: timeOrigin + profile.startTime,
    endTimestampMs: timeOrigin + profile.commitTime,
    description: profile.id,
    attributes: {
      [ATTR_PHASE]: profile.phase,
      [ATTR_DURATION]: profile.actualDuration,
      [ATTR_BASE_DURATION]: profile.baseDuration,
    },
  });
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
