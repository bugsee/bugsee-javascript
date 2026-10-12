import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { severityToWire } from '@bugsee/protocol';
import type { AttributeValue, SeverityName } from '@bugsee/types';
import { randomId, utf8ByteLength } from '@bugsee/util';
import type { Clock } from './clock';
import { parseSeverityName } from './reporting';
import type { NotifyItem, NotifyResult } from './transport';

// The `notify()` relay (mobile `Bugsee.notify`, Android `BugseeNotificationRelayCoordinator`): a message to
// the app's configured messaging integrations (Slack, webhooks, ...) that skips the bug-report pipeline
// entirely — no video, logs or events. Messages are queued, sent in batches, and retried with backoff.
//
// Mobile persists the queue to disk so a message survives a restart. This relay is IN MEMORY: a page that closes with an unsent message loses it.
// `flush()` is the mitigation — `client.stop()`/`client.flush()` call it — and the queue survives a
// stop()/launch() cycle within one page.
//
// Limits, all from the mobile SDKs: a batch is at most 50 notifications / 256 KB, one notification at most
// 256 KB, a failed batch is retried with a 2 s -> 60 s exponential backoff, the pending queue holds at most
// 1 MB (1000 items) and nothing older than 72 h is sent (Android's relay storage caps).

const MAX_BATCH_COUNT = 50;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_ITEM_BYTES = 256 * 1024;
/** In-memory bound; mobile's equivalent is its storage count cap. The oldest message is dropped. */
const MAX_PENDING = 1000;
/** Total queued bytes (Android's relay storage cap). The oldest are dropped first. */
const MAX_QUEUE_BYTES = 1024 * 1024;
/** A notification older than this is dropped instead of sent (Android: 72 h). */
const MAX_AGE_MS = 72 * 3600_000;
/** The longest wait a collector `retryAfter` may impose. */
const MAX_RETRY_AFTER_MS = 600_000;
const RETRY_INITIAL_MS = 2000;
const RETRY_MAX_MS = 60_000;

export interface RelayTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimers = globalThis as unknown as {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
const defaultTimers: RelayTimers = {
  setTimeout: (callback, ms) => {
    const handle = globalTimers.setTimeout(callback, ms);
    // A pending notification must not keep a Node process alive; no-op in the browser.
    (handle as { unref?: () => void } | null)?.unref?.();
    return handle;
  },
  clearTimeout: (handle) => globalTimers.clearTimeout(handle),
};

/** What `notify()` was called with. */
export interface NotifyInput {
  title: string;
  body?: string;
  severity?: SeverityName;
  fields?: Record<string, string>;
  urgent?: boolean;
}

/** The state stamped onto a notification at the moment `notify()` was called. */
export interface NotifySnapshot {
  userIdentifier?: string | null;
  attributes?: Record<string, AttributeValue>;
  environment?: EnvironmentEnvelope;
}

export interface NotifyRelayOptions {
  /** Deliver one batch. Must not throw; a throw is treated as a transient failure. */
  send: (items: readonly NotifyItem[]) => Promise<NotifyResult>;
  clock: Clock;
  /** Window (ms) after the first notification during which more can join its batch. 0 = this tick. */
  flushDelayMs: number;
  /** User / attributes / environment as of the `notify()` call. A throw omits them (-> onError). */
  snapshot?: () => NotifySnapshot;
  timers?: RelayTimers;
  /** Notification id generator. Default `randomId()`. */
  newId?: () => string;
  onError?: (error: unknown) => void;
  /**
   * Where a batch that was in a request when {@link NotifyRelay.take} ran goes if it then FAILS: the
   * relay has been handed over and will not be resumed, so putting it back into its own queue would lose it.
   * Without a sink the items stay in the queue.
   */
  onHandBack?: (items: NotifyItem[]) => void;
  /** The collector answered `403 KillSdk`: the owner should enter its kill state. Called once. */
  onKill?: () => void;
}

export interface NotifyRelay {
  /** Validate, snapshot and queue a notification. Never throws; an invalid one is ignored. */
  enqueue(input: NotifyInput): void;
  /** Send everything pending now. Resolves true when nothing is left pending. */
  flush(): Promise<boolean>;
  /**
   * Stop sending: cancel the scheduled flush and the backoff, and refuse to send or re-arm a retry until
   * {@link NotifyRelay.resume}. The queue is kept.
   */
  suspend(): void;
  /** Undo `suspend()` (a re-launch) and schedule what was kept. */
  resume(): void;
  /** Number of notifications not yet delivered: queued, or in a request that has not answered. */
  pending(): number;
  /**
   * Remove and return the QUEUED notifications (not the ones in a request that has not answered): the
   * hand-over of a client that is being replaced by `relaunch()`. Cancels the scheduled send and backoff.
   */
  take(): NotifyItem[];
  /** Put notifications handed over by {@link NotifyRelay.take} ahead of the queue, under the same caps. */
  adopt(items: readonly NotifyItem[]): void;
}

const jsonBytes = (item: NotifyItem): number => utf8ByteLength(JSON.stringify(item));

/** Only string-to-string entries are valid fields; anything else is dropped. */
function sanitizeFields(fields: unknown): Record<string, string> | undefined {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function createNotifyRelay(options: NotifyRelayOptions): NotifyRelay {
  const { send, clock, flushDelayMs } = options;
  const timers = options.timers ?? defaultTimers;
  const newId = options.newId ?? randomId;
  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // a throwing sink must not break delivery
    }
  };

  let queue: NotifyItem[] = [];
  let flushTimer: unknown = null;
  let retryTimer: unknown = null;
  let retryDelay = RETRY_INITIAL_MS;
  let running: Promise<boolean> | null = null;
  /** Settles when every urgent send started so far has. A chain, so finished sends are not retained. */
  const urgentSends = new Set<Promise<void>>();
  let inFlightItems = 0;
  /** A stopped SDK (stop() / kill) sends and retries nothing. Cleared by `resume()` on launch. */
  let stopped = false;
  let killed = false;
  /** `take()` ran and nothing has resumed the relay: whatever a request still in flight fails to deliver is handed back. */
  let handedOver = false;
  /** A 429's `retryAfter`, consumed by the next `scheduleRetry`. */
  let retryHintMs: number | undefined;
  /** Consecutive 429 answers; a second one in a row halves the batch (the collector may be refusing its size). */
  let consecutiveRateLimits = 0;
  /** The current batch-size ceiling: MAX_BATCH_COUNT, halved by repeated 429s, doubled back by successes. */
  let batchCap = MAX_BATCH_COUNT;
  const sizes = new WeakMap<NotifyItem, number>();
  const sizeOf = (item: NotifyItem): number => {
    let size = sizes.get(item);
    if (size === undefined) {
      size = jsonBytes(item);
      sizes.set(item, size);
    }
    return size;
  };

  /** Drop what is too old to be worth sending (72 h). */
  const dropExpired = (): void => {
    const cutoff = clock.wallNow() - MAX_AGE_MS;
    const kept = queue.filter((item) => item.timestamp >= cutoff);
    if (kept.length !== queue.length) {
      report(
        new Error(`notify: dropped ${queue.length - kept.length} notification(s) older than 72 h`),
      );
      queue = kept;
    }
  };

  /** Remove and return the oldest item, preferring a non-urgent one: an urgent notification outlives routine ones. */
  const dropOldest = (): NotifyItem => {
    const at = queue.findIndex((item) => item.urgent !== true);
    return queue.splice(at === -1 ? 0 : at, 1)[0] as NotifyItem;
  };

  /** Keep at most MAX_PENDING items and MAX_QUEUE_BYTES bytes, dropping the oldest; and nothing past 72 h. */
  const trim = (): void => {
    dropExpired();
    while (queue.length > MAX_PENDING) {
      dropOldest();
      report(
        new Error(`notify: more than ${MAX_PENDING} notifications pending; dropped the oldest`),
      );
    }
    let bytes = queue.reduce((sum, item) => sum + sizeOf(item), 0);
    while (bytes > MAX_QUEUE_BYTES && queue.length > 1) {
      bytes -= sizeOf(dropOldest());
      report(new Error('notify: more than 1 MB of notifications pending; dropped the oldest'));
    }
  };

  /** Settle one batch. true = done with it (delivered or dropped); false = some of it must be retried. */
  const dispatch = async (batch: NotifyItem[], skipAhead: boolean): Promise<boolean> => {
    const stamped = batch.map(
      (item): NotifyItem => ({
        ...item,
        delivery:
          skipAhead || (item.urgent !== true && flushDelayMs <= 0) ? 'immediate' : 'deferred',
      }),
    );
    let result: NotifyResult;
    inFlightItems += batch.length;
    try {
      result = await send(stamped);
    } catch {
      result = { outcome: 'retry' };
    } finally {
      inFlightItems -= batch.length;
    }
    if (result.outcome === 'sent') {
      retryDelay = RETRY_INITIAL_MS;
      consecutiveRateLimits = 0;
      batchCap = Math.min(batchCap * 2, MAX_BATCH_COUNT);
      return true;
    }
    if (result.outcome === 'kill') {
      killed = true;
      stopped = true;
      queue = [];
      clearFlushTimer();
      clearRetryTimer();
      try {
        options.onKill?.();
      } catch (error) {
        report(error);
      }
      return true;
    }
    if (result.outcome === 'rejected') {
      report(new Error(`notify: the collector rejected ${batch.length} notification(s); dropped`));
      return true;
    }
    if (result.rateLimited === true) {
      consecutiveRateLimits += 1;
      if (consecutiveRateLimits >= 2) {
        batchCap = Math.max(1, Math.floor(batchCap / 2));
      }
    } else {
      consecutiveRateLimits = 0;
    }
    if (result.retryAfterMs !== undefined) {
      retryHintMs = Math.min(Math.max(result.retryAfterMs, 0), MAX_RETRY_AFTER_MS);
    }
    const wanted = result.retryIds;
    const back = wanted === undefined ? batch : batch.filter((item) => wanted.includes(item.id));
    if (handedOver && options.onHandBack !== undefined) {
      if (back.length > 0) {
        try {
          options.onHandBack(back);
        } catch (error) {
          report(error);
        }
      }
      return false;
    }
    // Back in timestamp order (stable): a failed urgent send is the NEWEST item, so the cap drops the oldest
    // queued ones, not it. (Timestamps can tie within a millisecond, so `trim` also prefers non-urgent victims.)
    queue = [...back, ...queue].sort((a, b) => a.timestamp - b.timestamp);
    trim();
    return false;
  };

  const takeBatch = (): NotifyItem[] => {
    let bytes = 0;
    let count = 0;
    while (count < queue.length && count < batchCap) {
      // MAX_ITEM_BYTES <= MAX_BATCH_BYTES, so the first item always fits and a batch is never empty.
      const size = jsonBytes(queue[count] as NotifyItem);
      if (bytes + size > MAX_BATCH_BYTES) {
        break;
      }
      bytes += size;
      count += 1;
    }
    return queue.splice(0, count);
  };

  const drain = async (): Promise<boolean> => {
    for (;;) {
      dropExpired();
      if (queue.length === 0 || stopped) {
        break;
      }
      if (!(await dispatch(takeBatch(), false))) {
        scheduleRetry();
        return false;
      }
    }
    if (queue.length === 0) {
      clearRetryTimer(); // everything is out: a backoff armed by an earlier failure has nothing left to do
    }
    return queue.length === 0;
  };

  const clearFlushTimer = (): void => {
    if (flushTimer !== null) {
      timers.clearTimeout(flushTimer);
      flushTimer = null;
    }
  };
  const clearRetryTimer = (): void => {
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleRetry = (): void => {
    clearRetryTimer();
    if (stopped) {
      return; // a stopped SDK keeps no timer, and so sends no request, alive
    }
    // The collector's hint is a floor-raiser, never a floor-remover: `Retry-After: 0` (or 0.0001 s) must
    // not become a hammer loop, so the wait is never below the current backoff step, which keeps growing.
    let wait = retryDelay;
    if (retryHintMs !== undefined) {
      wait = Math.max(retryHintMs, retryDelay);
      retryHintMs = undefined;
    }
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      void flush();
    }, wait);
  };

  const flush = async (): Promise<boolean> => {
    clearFlushTimer();
    // drain() itself refuses to send while stopped, so a stopped flush only waits for what is in flight.
    running ??= drain().finally(() => {
      running = null;
    });
    const drained = await running;
    while (urgentSends.size > 0) {
      await Promise.allSettled([...urgentSends]);
    }
    return drained && queue.length === 0;
  };

  const scheduleFlush = (): void => {
    // A backing-off retry already owns the next send; sending newer messages ahead of it would both
    // hammer a failing endpoint and reorder the queue.
    if (stopped || flushTimer !== null || retryTimer !== null) {
      return;
    }
    flushTimer = timers.setTimeout(() => {
      flushTimer = null;
      void flush();
    }, flushDelayMs);
  };

  const sendUrgent = (item: NotifyItem): void => {
    const attempt: Promise<void> = dispatch([item], true)
      .then((done) => {
        if (!done) {
          scheduleRetry();
        }
      })
      .finally(() => {
        urgentSends.delete(attempt);
      });
    urgentSends.add(attempt);
  };

  return {
    enqueue(input: NotifyInput): void {
      if (killed) {
        return;
      }
      if (typeof input.title !== 'string' || input.title.length === 0) {
        return;
      }
      const item: NotifyItem = { id: newId(), timestamp: clock.wallNow(), title: input.title };
      if (typeof input.body === 'string') {
        item.body = input.body;
      }
      const severity = parseSeverityName(input.severity);
      if (severity !== undefined) {
        item.severity = severityToWire(severity);
      }
      const fields = sanitizeFields(input.fields);
      if (fields !== undefined) {
        item.fields = fields;
      }
      if (input.urgent === true) {
        item.urgent = true;
      }
      try {
        const snapshot = options.snapshot?.();
        if (snapshot?.userIdentifier) {
          item.user = { email: snapshot.userIdentifier };
        }
        if (snapshot?.attributes && Object.keys(snapshot.attributes).length > 0) {
          item.attributes = snapshot.attributes;
        }
        if (snapshot?.environment !== undefined) {
          item.environment = snapshot.environment;
        }
      } catch (error) {
        report(error);
      }
      if (jsonBytes(item) > MAX_ITEM_BYTES) {
        report(new Error('notify: notification is larger than 256 KB; ignored'));
        return;
      }
      // Urgent skips the flush WINDOW, never the retry backoff: during one it waits with the rest, or an urgent
      // loop against a rate-limiting collector would hammer it.
      if (item.urgent === true && !stopped && retryTimer === null) {
        sendUrgent(item);
        return;
      }
      queue.push(item);
      trim();
      scheduleFlush();
    },

    flush,

    suspend(): void {
      stopped = true;
      clearFlushTimer();
      clearRetryTimer();
    },

    resume(): void {
      // After a kill verdict the queue is empty and `enqueue` refuses everything, so there is nothing to resume.
      stopped = false;
      handedOver = false;
      if (queue.length > 0) {
        scheduleFlush();
      }
    },

    pending(): number {
      return queue.length + inFlightItems;
    },

    take(): NotifyItem[] {
      const taken = queue;
      queue = [];
      handedOver = true;
      clearFlushTimer();
      clearRetryTimer();
      return taken;
    },

    adopt(items: readonly NotifyItem[]): void {
      if (killed || items.length === 0) {
        return;
      }
      queue = [...items, ...queue];
      trim();
      scheduleFlush();
    },
  };
}
