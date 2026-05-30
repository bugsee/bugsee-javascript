import process from 'node:process';
import type { SystemEvent } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { ProcessEvents } from './detection-providers';

// Node system-event SOURCE for @bugsee/capture's systemEventsProvider (Android events.system parity,
// Node subset). A listenable InterceptorBase: while active it emits a 'process_started' marker, then
// forwards process lifecycle events via process.on — 'process_exiting' (the 'exit' event, with code),
// 'process_before_exit' (the 'beforeExit' clean-drain event, distinct from exit), 'process_warning'
// (deprecations/etc.), and 'process_signal' for termination signals (SIGTERM/SIGINT). On deactivate it
// removes the listeners. Mobile-only system events (activity lifecycle, orientation, keyboard, clipboard)
// have no Node analog.
//
// SIGNAL SAFETY: registering a signal listener SUPPRESSES Node's default termination, so a naive
// observer would hang a process that has no other handler. We capture passively: emit the event, then
// — only when the SDK is the SOLE handler (listenerCount === 1, so the default was suppressed because
// of us) — remove our handler and RE-RAISE the signal so the default termination still happens. When
// the app has its own handler too (count > 1), that handler already fired alongside ours and owns the
// shutdown decision, so we just observe. The process emitter + signal control are injectable for tests.

const DEFAULT_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** Seam for the signal re-raise logic (the parts not on the minimal {@link ProcessEvents}). */
export interface SignalControl {
  /** How many listeners are registered for `signal` (to detect if the SDK is the sole handler). */
  listenerCount(signal: string): number;
  /** Re-deliver `signal` to this process so the default termination happens after the SDK observed it. */
  reRaise(signal: string): void;
}

export interface NodeSystemEventsOptions {
  /** Termination signals to capture passively. Default ['SIGTERM', 'SIGINT']. */
  signals?: readonly string[];
  /**
   * Signal control (listener count + re-raise). Default the real node:process. Co-inject this with a
   * custom `proc`: the default reads/kills the REAL process, so a fake `proc` alone would be inconsistent.
   */
  signalControl?: SignalControl;
}

const defaultSignalControl: SignalControl = {
  listenerCount: (signal) => process.listenerCount(signal),
  reRaise: (signal) => {
    process.kill(process.pid, signal as NodeJS.Signals);
  },
};

const warningParams = (warning: unknown): Record<string, unknown> =>
  warning instanceof Error
    ? { name: warning.name, message: warning.message }
    : { message: String(warning) };

class NodeSystemEventsSource extends InterceptorBase<{ event: SystemEvent }> {
  readonly name = 'node-system-events';
  readonly #proc: ProcessEvents;
  readonly #signalControl: SignalControl;
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
    this.#signalControl = options.signalControl ?? defaultSignalControl;
    const signals = options.signals ?? DEFAULT_SIGNALS;
    this.#signalHandlers = new Map(signals.map((sig) => [sig, () => this.#onSignal(sig)]));
  }

  #onSignal(signal: string): void {
    this.emit('event', { name: 'process_signal', params: { signal } });
    // Sole handler → the default termination was suppressed by us; restore it (remove self, re-raise).
    if (this.#signalControl.listenerCount(signal) === 1) {
      const handler = this.#signalHandlers.get(signal);
      if (handler !== undefined) {
        this.#proc.off(signal, handler);
      }
      this.#signalControl.reRaise(signal);
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
