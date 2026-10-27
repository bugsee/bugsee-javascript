import type { ScreenTracker } from '@bugsee/core';
import { TraceProducerBase } from './trace-producer';

// The `route` and `view` system traces (spec traces.md `route` / `view`): what the application reports through
// `client.setRoute` / `client.setView` (framework adapters feed them from their router hooks). Both are held step curves,
// so they are `emitIfChanged`; the tracker already drops a repeat, this keeps the producer correct on its own too.
// The values arrive sanitized and bounded; this producer only turns tracker state into trace entries.

/** The part of the screen tracker this producer reads. */
export type ScreenSource = Pick<ScreenTracker, 'on' | 'currentRoute' | 'currentView'>;

/** Which of the two traces this host writes. A name the host owns (a native WebView writes `view`) is `false`. */
export interface ScreenProducerOptions {
  route?: boolean;
  view?: boolean;
}

export class ScreenProducer extends TraceProducerBase {
  readonly name = 'screen';
  readonly #tracker: ScreenSource;
  readonly #route: boolean;
  readonly #view: boolean;
  #offs: Array<() => void> = [];

  constructor(tracker: ScreenSource, options: ScreenProducerOptions = {}) {
    super();
    this.#tracker = tracker;
    this.#route = options.route !== false;
    this.#view = options.view !== false;
  }

  protected onStart(): void {
    if (this.#route) {
      this.#offs.push(this.#tracker.on('route', (e) => this.emitIfChanged('route', e.route)));
      // What was set before the capture started (an adapter wires at app start, before or after launch) is the baseline.
      const route = this.#tracker.currentRoute();
      if (route !== undefined) this.emitIfChanged('route', route);
    }
    if (this.#view) {
      this.#offs.push(this.#tracker.on('view', (e) => this.emitIfChanged('view', e.view)));
      const view = this.#tracker.currentView();
      if (view !== undefined) this.emitIfChanged('view', view);
    }
  }

  protected override onStop(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
  }
}
