// The page script of `test/replay-masking.browser.e2e.ts`: the REAL rrweb record bundle (`@bugsee/rrweb`) driven
// with the REAL `resolveReplayMaskingOptions`, in two modes —
//   `raw`      `record()` called directly (what the recorder itself guarantees; no SDK guard in between), and
//   `provider` the SDK's replay capture provider (recorder + the blocked-iframe guard on the emit path).
// Every event the page produces is collected on `window.__rm.events` for the harness to search for secrets.
import { createReplayCaptureProvider, resolveReplayMaskingOptions } from '@bugsee/replay';
import { type eventWithTime, record } from '@bugsee/rrweb';

type Mode = 'raw' | 'provider';

interface Controller {
  events: unknown[];
  /** What the provider reported through `onError` (provider mode). */
  errors: string[];
  start(mode: Mode, options: Record<string, unknown>): void;
  stop(): void;
  startBlackout(): void;
  stopBlackout(): void;
  snapshot(): void;
}

const w = window as unknown as { __rm: Controller };

let mode: Mode = 'raw';
let options: Record<string, unknown> = {};
let stopRaw: (() => void) | undefined;
let provider: ReturnType<typeof createReplayCaptureProvider> | undefined;

function startRaw(): void {
  stopRaw = record({
    ...resolveReplayMaskingOptions(options),
    recordCrossOriginIframes: false,
    emit: (event: eventWithTime) => {
      w.__rm.events.push(event);
    },
  } as never) as (() => void) | undefined;
}

w.__rm = {
  events: [],
  errors: [],
  start(nextMode, nextOptions) {
    mode = nextMode;
    options = nextOptions;
    if (mode === 'raw') {
      startRaw();
      return;
    }
    provider = createReplayCaptureProvider({
      record: record as never,
      masking: resolveReplayMaskingOptions(options),
      onError: (error) => {
        w.__rm.errors.push(String(error));
      },
    });
    provider.init({
      captureAggregator: {
        addEntry: (entry: { data: unknown }) => {
          w.__rm.events.push(entry.data);
        },
      },
    } as never);
    provider.start({} as never);
  },
  stop() {
    if (mode === 'raw') {
      stopRaw?.();
      stopRaw = undefined;
    } else {
      provider?.stop();
      provider = undefined;
    }
  },
  // A "blackout" without a client: the recorder is stopped and started again (raw), or follows the
  // provider's own blackout controls (provider).
  startBlackout() {
    if (mode === 'raw') {
      stopRaw?.();
      stopRaw = undefined;
    } else {
      provider?.startBlackout();
    }
  },
  stopBlackout() {
    if (mode === 'raw') {
      startRaw();
    } else {
      provider?.stopBlackout();
    }
  },
  snapshot() {
    (record as unknown as { takeFullSnapshot(checkout?: boolean): void }).takeFullSnapshot(true);
  },
};
