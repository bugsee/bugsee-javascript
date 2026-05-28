import type { LogLevel } from '@bugsee/protocol';
import type { LogLevelName } from '@bugsee/types';

// Cross-runtime event payload types (design §10/§16). These are the shapes that capture SOURCES
// (interceptors / log sources) emit and CONSUMERS observe. There is no central hub: sources are
// listenable emitters subscribed to directly (see InterceptorBase / emitter.ts).

/** A captured log line (design §10) — the payload a log source (e.g. the console interceptor) emits. */
export interface LogEvent {
  timestamp: number;
  level: LogLevelName | LogLevel;
  source: string;
  tag?: string;
  message: string;
}

/**
 * Minimal cross-runtime input event (the design references InputEvent but leaves its shape to the
 * runtime). The `@bugsee/browser` input interceptor refines `type`/`target`/`data` with concrete DOM
 * specifics (click/keydown/scroll, selectors, …); core only fixes this base.
 */
export interface InputEvent {
  timestamp: number;
  type: string;
  target?: string;
  data?: Record<string, unknown>;
}
