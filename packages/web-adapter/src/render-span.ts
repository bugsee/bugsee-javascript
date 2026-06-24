import { type AdapterClientOptions, getPerformanceApi } from './adapter';

// Shared `ui.render` recorder for the framework render-span integrations (React Profiler / Vue render mixin /
// Angular [bugseeRender] directive / Svelte init-span injection). Each framework supplies a component name +
// the render's start/end (epoch ms) + phase; we record ONE `ui.render` child span on the active transaction
// (the navigation/interaction txn the render happened within) — so APM shows which components rendered, when,
// and for how long. ONE source of truth for the op + attribute keys, so every framework's spans are uniform.
// A no-op when there is no active transaction / no performance ext / no SDK.

/** The canonical render-span op + attribute keys (shared across every framework adapter). */
export const RENDER_SPAN_OP = 'ui.render';
export const RENDER_PHASE_ATTRIBUTE = 'ui.render_phase';
export const RENDER_DURATION_ATTRIBUTE = 'ui.render_duration_ms';

export interface RenderSpanInput {
  /** The component name — the span description. */
  name: string;
  /** Render start, epoch ms (e.g. `performance.timeOrigin + performance.now()`). */
  startTimestampMs: number;
  /** Render end, epoch ms. */
  endTimestampMs: number;
  /** The render phase (e.g. 'mount' | 'update'). Stamped as `ui.render_phase` when present. */
  phase?: string;
  /** The render DURATION in ms. Defaults to `endTimestampMs - startTimestampMs`; supplied explicitly when
   *  the framework reports a render cost distinct from the wall-clock extent (e.g. React's actualDuration). */
  durationMs?: number;
  /** Extra framework-specific attributes (merged after the canonical phase/duration). */
  attributes?: Record<string, string | number | boolean>;
}

/** Record one `ui.render` child span on the active transaction. A no-op when no transaction is active (the
 *  render is not part of a captured trace), or when the SDK / performance extension is absent. */
export function recordRenderSpan(span: RenderSpanInput, options: AdapterClientOptions = {}): void {
  const active = getPerformanceApi(options.getClient)?.getActiveSpan();
  if (active === undefined) return;
  const duration = span.durationMs ?? span.endTimestampMs - span.startTimestampMs;
  active.recordChildSpan(RENDER_SPAN_OP, {
    startTimestampMs: span.startTimestampMs,
    endTimestampMs: span.endTimestampMs,
    description: span.name,
    attributes: {
      // Extras first → the dedicated `durationMs`/`phase` fields stay AUTHORITATIVE (a framework's extra
      // attribute can't accidentally clobber the canonical duration/phase).
      ...span.attributes,
      [RENDER_DURATION_ATTRIBUTE]: duration,
      ...(span.phase !== undefined ? { [RENDER_PHASE_ATTRIBUTE]: span.phase } : {}),
    },
  });
}
