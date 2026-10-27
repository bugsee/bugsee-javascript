import type { ScreenTracker } from '@bugsee/core';
import { TraceName } from '@bugsee/protocol';
import { TraceProducerBase } from './trace-producer';

// The `route` and `view` system traces (spec traces.md `route` / `view`): what the application reports through
// `client.setRoute` / `client.setView` (framework adapters feed them from their router hooks). Both are held step curves,
// so they are `emitIfChanged`; the tracker already drops a repeat, this keeps the producer correct on its own too.
// The values arrive sanitized and bounded; this producer only turns tracker state into trace entries.

/** The part of the screen tracker this producer reads. */
export type ScreenSource = Pick<ScreenTracker, 'on' | 'currentRoute' | 'currentView'>;

export class ScreenProducer extends TraceProducerBase {
  readonly name = 'screen';
  readonly #tracker: ScreenSource;
  #offs: Array<() => void> = [];

  constructor(tracker: ScreenSource) {
    super();
    this.#tracker = tracker;
  }

  protected onStart(): void {
    this.#offs.push(this.#tracker.on('route', (e) => this.emitIfChanged(TraceName.ROUTE, e.route)));
    // What was set before the capture started (an adapter wires at app start, before or after launch) is the baseline.
    const route = this.#tracker.currentRoute();
    if (route !== undefined) this.emitIfChanged(TraceName.ROUTE, route);
    this.#offs.push(this.#tracker.on('view', (e) => this.emitIfChanged(TraceName.VIEW, e.view)));
    const view = this.#tracker.currentView();
    if (view !== undefined) this.emitIfChanged(TraceName.VIEW, view);
  }

  protected override onStop(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
  }
}
