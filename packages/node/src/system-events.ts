import process from 'node:process';
import type { SystemEvent } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { ProcessEvents } from './detection-providers';
import { markOwnHandler, releaseSignalToDefault } from './process-policy';

// Node system-event SOURCE for @bugsee/capture's systemEventsProvider (Android events.system parity,
// Node subset). A listenable InterceptorBase: while active it emits a 'process_started' marker, then
// forwards process lifecycle events via process.on — 'process_exiting' (the 'exit' event, with code),
// 'process_before_exit' (the 'beforeExit' clean-drain event, distinct from exit), 'process_warning'
// (deprecations/etc.), and 'process_signal' for termination signals (SIGTERM/SIGINT). On deactivate it
// removes the listeners. Mobile-only system events (activity lifecycle, orientation, keyboard, clipboard)
// have no Node analog.
//
// SIGNAL SAFETY: registering a signal listener SUPPRESSES Node's default termination, so a naive observer
// would hang a process that has no other handler. We capture passively: emit the event, then hand the signal
// back via the shared `releaseSignalToDefault` rule — remove our handler, and re-raise only if NO listener
// remains. That rule is shared with launch's flush-on-signal hook (Wave 6.1) because it has to hold when
// SEVERAL Bugsee listeners are installed, which the earlier `listenerCount === 1` gate did not: a second
// Bugsee listener made the count 2, both handlers read that as "the app owns shutdown", and the signal was
// never released — a SIGTERM left the process running forever.

const DEFAULT_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export interface NodeSystemEventsOptions {
  /** Termination signals to capture passively. Default ['SIGTERM', 'SIGINT']. */
  signals?: readonly string[];
}

const warningParams = (warning: unknown): Record<string, unknown> =>
  warning instanceof Error
    ? { name: warning.name, message: warning.message }
    : { message: String(warning) };

class NodeSystemEventsSource extends InterceptorBase<{ event: SystemEvent }> {
  readonly name = 'node-system-events';
  readonly #proc: ProcessEvents;
  readonly #signalHandlers: Map<string, (...args: unknown[]) => void>;

  readonly #onExit = (...args: unknown[]): void => {
    this.emit('event', {
      name: 'process_exiting',
      params: { code: typeof args[0] === 'number' ? args[0] : 0 },
    });
  };
  readonly #onBeforeExit = (...args: unknown[]): void => {
    this.emit('event', {
      name: 'process_before_exit',
      params: { code: typeof args[0] === 'number' ? args[0] : 0 },
    });
  };
  readonly #onWarning = (...args: unknown[]): void => {
    this.emit('event', { name: 'process_warning', params: warningParams(args[0]) });
  };

  constructor(proc: ProcessEvents, options: NodeSystemEventsOptions = {}) {
    super();
    this.#proc = proc;
    const signals = options.signals ?? DEFAULT_SIGNALS;
    // Marked as Bugsee's own so `foreignListenerCount` (the crash/rejection policy) does not mistake this
    // observer for a host signal handler.
    this.#signalHandlers = new Map(
      signals.map((sig) => [sig, markOwnHandler(() => this.#onSignal(sig))]),
    );
  }

  #onSignal(signal: string): void {
    this.emit('event', { name: 'process_signal', params: { signal } });
    const handler = this.#signalHandlers.get(signal);
    if (handler !== undefined) {
      releaseSignalToDefault(this.#proc, signal, handler);
    }
  }

  protected onActivate(): void {
    this.emit('event', { name: 'process_started' });
    this.#proc.on('exit', this.#onExit);
    this.#proc.on('beforeExit', this.#onBeforeExit);
    this.#proc.on('warning', this.#onWarning);
    for (const [signal, handler] of this.#signalHandlers) {
      this.#proc.on(signal, handler);
    }
  }

  protected override onDeactivate(): void {
    this.#proc.off('exit', this.#onExit);
    this.#proc.off('beforeExit', this.#onBeforeExit);
    this.#proc.off('warning', this.#onWarning);
    for (const [signal, handler] of this.#signalHandlers) {
      this.#proc.off(signal, handler);
    }
  }
}

export function createNodeSystemEventsSource(
  proc: ProcessEvents = process,
  options: NodeSystemEventsOptions = {},
): Interceptor<{ event: SystemEvent }> {
  return new NodeSystemEventsSource(proc, options);
}
