import type { LogLevel, NetworkEvent } from '@bugsee/protocol';
import type { LogLevelName } from '@bugsee/types';
import { createEventEmitter, type EventEmitter } from './event-emitter';

// Process-wide event hubs (design §16.2). Sources (interceptors/adapters) emit to these hubs
// UNCONDITIONALLY; the capture pipeline is one subscriber among many (APM, extensions, custom
// listeners). Mirrors Android NetworkEventHub / LogEventHub / InputEventHub.

/** A captured log line (design §10). Carried on logEventHub before sanitize/serialize. */
export interface LogEvent {
  timestamp: number;
  level: LogLevelName | LogLevel;
  source: string;
  tag?: string;
  message: string;
}

/**
 * Minimal cross-runtime input event (the design references InputEvent for the input hub but leaves
 * its shape to the runtime). The `@bugsee/browser` input interceptor refines `type`/`target`/`data`
 * with concrete DOM specifics (click/keydown/scroll, selectors, …); core only fixes this base.
 */
export interface InputEvent {
  timestamp: number;
  type: string;
  target?: string;
  data?: Record<string, unknown>;
}

/** The three core hubs (design §16.2). Extensions add hubs via declaration-merge on NameHubMapping. */
export interface EventHubs {
  network: EventEmitter<NetworkEvent>;
  log: EventEmitter<LogEvent>;
  input: EventEmitter<InputEvent>;
}

export function createEventHubs(onListenerError?: (err: unknown) => void): EventHubs {
  return {
    network: createEventEmitter<NetworkEvent>(onListenerError),
    log: createEventEmitter<LogEvent>(onListenerError),
    input: createEventEmitter<InputEvent>(onListenerError),
  };
}
