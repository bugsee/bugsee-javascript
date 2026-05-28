import process from 'node:process';
import type { SystemEvent } from '@bugsee/capture';
import { type Interceptor, InterceptorBase } from '@bugsee/core';
import type { ProcessEvents } from './detection-providers';

// Node system-event SOURCE for @bugsee/capture's systemEventsProvider (Android events.system parity,
// Node subset). A listenable InterceptorBase: while active it emits a 'process_started' marker, then
// forwards process lifecycle events — 'process_exiting' (with the exit code) and 'process_warning'
// (deprecations/etc.) — via process.on; on deactivate it removes the listeners. Mobile-only system
// events (activity lifecycle, orientation, keyboard, clipboard) have no Node analog. The process
// emitter is injectable for tests.

const warningParams = (warning: unknown): Record<string, unknown> =>
  warning instanceof Error
    ? { name: warning.name, message: warning.message }
    : { message: String(warning) };

class NodeSystemEventsSource extends InterceptorBase<{ event: SystemEvent }> {
  readonly name = 'node-system-events';
  readonly #proc: ProcessEvents;
  readonly #onExit = (...args: unknown[]): void => {
    this.emit('event', {
      name: 'process_exiting',
      params: { code: typeof args[0] === 'number' ? args[0] : 0 },
    });
  };
  readonly #onWarning = (...args: unknown[]): void => {
    this.emit('event', { name: 'process_warning', params: warningParams(args[0]) });
  };

  constructor(proc: ProcessEvents) {
    super();
    this.#proc = proc;
  }

  protected onActivate(): void {
    this.emit('event', { name: 'process_started' });
    this.#proc.on('exit', this.#onExit);
    this.#proc.on('warning', this.#onWarning);
  }

  protected override onDeactivate(): void {
    this.#proc.off('exit', this.#onExit);
    this.#proc.off('warning', this.#onWarning);
  }
}

export function createNodeSystemEventsSource(
  proc: ProcessEvents = process,
): Interceptor<{ event: SystemEvent }> {
  return new NodeSystemEventsSource(proc);
}
