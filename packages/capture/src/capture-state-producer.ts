import type { BlackoutGate, DiskPressure } from '@bugsee/core';
import { TraceName } from '@bugsee/protocol';
import { TraceProducerBase } from './trace-producer';

// The `capture` system trace (spec `bundle/traces.md#capture`, mobile parity; JavaScript C7): whether VISUAL capture
// is live and, when it is not, why. `value` is the object `{state}`; it is a HELD step trace (written on change,
// re-recorded by the provider), so a consumer reading a window always finds the current state.
//
//   active           visual capture is running and not blacked out
//   blackout         the application asked for it (`startBlackout`); frames are still produced, rendered black
//   low_disk_space   free space under the low threshold (iOS 50 MB): replay/log/network stop reaching disk
//   no_disk_space    free space under the out-of-space threshold (iOS 10 MB): nothing reaches disk
//
// Disk outranks blackout (iOS): a shortage explains far more of a thin report than a deliberate redaction does.
// Nothing at all is written until the host says its recorder runs (`setVisualCapture(true)`): that includes the disk
// states, because a held `low_disk_space` for a capture that never started would be re-recorded as if it were true.
//
// WHO BUILDS IT. Only a host that HAS visual capture: the browser with rrweb replay on, Electron main with pixel
// video. Node/Bun/Deno never build one (an `active` there would assert a capture that is not running), and WebViews and
// Electron renderers must not (the native host / main writes it). `active`/`blackout` are written only after
// `setVisualCapture(true)` (the host says the recorder really started), and so do the disk states.
//
// LATE BINDING. The producer is built before the client (the traces provider needs it), while the blackout state and
// the disk pressure belong to the client / the platform launch, so they are bound afterwards; binding re-evaluates.

/** The wire values of the `capture` trace. */
export type CaptureStateName = 'active' | 'blackout' | 'low_disk_space' | 'no_disk_space';

export class CaptureStateProducer extends TraceProducerBase {
  readonly name = 'capture-state';
  #blackout: BlackoutGate | undefined;
  #pressure: DiskPressure | undefined;
  #visual = false;
  #running = false;
  #offBlackout: (() => void) | undefined;
  #offPressure: (() => void) | undefined;

  /** Follow the session's blackout state. Binding again replaces the previous gate. */
  bindBlackout(gate: BlackoutGate): void {
    this.#offBlackout?.();
    this.#offBlackout = undefined;
    this.#blackout = gate;
    if (this.#running) {
      this.#offBlackout = gate.onChange(() => this.#refresh());
      this.#refresh();
    }
  }

  /** Follow the launch's disk pressure (only when `captureDiskSpace` is on). */
  bindPressure(pressure: DiskPressure): void {
    this.#offPressure?.();
    this.#offPressure = undefined;
    this.#pressure = pressure;
    if (this.#running) {
      this.#offPressure = pressure.onChange(() => this.#refresh());
      this.#refresh();
    }
  }

  /** The host reports whether its visual recorder is actually running. */
  setVisualCapture(running: boolean): void {
    this.#visual = running;
    this.#refresh();
  }

  protected onStart(): void {
    this.#running = true;
    this.#offBlackout = this.#blackout?.onChange(() => this.#refresh());
    this.#offPressure = this.#pressure?.onChange(() => this.#refresh());
    this.#refresh();
  }

  protected override onStop(): void {
    this.#running = false;
    this.#offBlackout?.();
    this.#offBlackout = undefined;
    this.#offPressure?.();
    this.#offPressure = undefined;
  }

  #state(): CaptureStateName | undefined {
    // No recorder, no claim: neither `active` nor a disk state describes a capture that is not running (a held trace
    // cannot be retracted, so a state written now would be re-recorded as if it were still true).
    if (!this.#visual) return undefined;
    const level = this.#pressure?.level();
    if (level === 'none') return 'no_disk_space';
    if (level === 'low') return 'low_disk_space';
    return this.#blackout?.isActive() === true ? 'blackout' : 'active';
  }

  #refresh(): void {
    const state = this.#state();
    if (state !== undefined) this.emitIfChanged(TraceName.CAPTURE, { state });
  }
}
