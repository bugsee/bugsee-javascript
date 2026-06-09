import type { PerformanceEntryLike, WebVitalsEnv } from './env';
import { bindReporter, initMetric, type Metric, THRESHOLDS } from './metric';
import { getNavigationType } from './navigation';
import { observe, onHidden } from './observe';
import type { VitalReportOptions } from './vitals';

// INP (reimplemented from web-vitals onINP — design reference). The hardest metric: group `event` +
// `first-input` entries by interactionId (an interaction's latency = the MAX duration across its entries),
// keep the 10 LONGEST interactions, and estimate the p98 via index floor(interactionCount / 50) — so
// under 50 interactions INP is the single worst, and every additional 50 lets one more outlier be
// skipped. interactionCount is the native counter when present, else polyfilled from the interactionId
// range ((max − min)/7 + 1, since ids increment by 7). Sub-threshold (<40ms) events are filtered by the
// observer; `first-input` (no threshold) is the fallback so a single small interaction still reports.

const MAX_INTERACTIONS = 10;
const DEFAULT_DURATION_THRESHOLD = 40;
const MAX_PLAUSIBLE_INP = 60_000; // drop hour-long outliers
const INTERACTION_ID_INCREMENT = 7;

export interface INPReportOptions extends VitalReportOptions {
  /** Minimum interaction duration (ms) to observe. Default 40. */
  durationThreshold?: number;
}

interface EventTimingLike extends PerformanceEntryLike {
  readonly interactionId?: number;
}

interface Interaction {
  id: number;
  latency: number;
  entries: PerformanceEntryLike[];
}

const nativeInteractionCount = (env: WebVitalsEnv): number | undefined =>
  (env.performance as { interactionCount?: number } | undefined)?.interactionCount;

export function onINP(
  env: WebVitalsEnv,
  callback: (metric: Metric) => void,
  opts: INPReportOptions = {},
): void {
  const durationThreshold = opts.durationThreshold ?? DEFAULT_DURATION_THRESHOLD;
  const metric = initMetric('INP', getNavigationType(env));
  const report = bindReporter(callback, metric, THRESHOLDS.INP, opts.reportAllChanges);

  const longest: Interaction[] = [];
  const byId = new Map<number, Interaction>();
  let minId = Number.POSITIVE_INFINITY;
  let maxId = 0;

  const interactionCount = (): number => {
    const native = nativeInteractionCount(env);
    if (native !== undefined) return native;
    return maxId > 0 ? (maxId - minId) / INTERACTION_ID_INCREMENT + 1 : 0;
  };

  const processEntry = (entry: EventTimingLike): void => {
    if (entry.duration > MAX_PLAUSIBLE_INP) return; // drop implausible (hour-long) outliers
    if (!entry.interactionId && entry.entryType !== 'first-input') return; // not an interaction
    const id = entry.interactionId ?? 0;
    const existing = byId.get(id);
    if (existing !== undefined) {
      existing.latency = Math.max(existing.latency, entry.duration); // latency = max across the group
      existing.entries.push(entry);
    } else {
      const interaction: Interaction = { id, latency: entry.duration, entries: [entry] };
      byId.set(id, interaction);
      longest.push(interaction);
    }
    longest.sort((a, b) => b.latency - a.latency);
    for (const removed of longest.splice(MAX_INTERACTIONS)) byId.delete(removed.id);
  };

  const estimateP98 = (): Interaction | undefined => {
    const index = Math.min(longest.length - 1, Math.floor(interactionCount() / 50));
    return longest[index];
  };

  const handleEntries = (entries: PerformanceEntryLike[]): void => {
    for (const entry of entries) processEntry(entry as EventTimingLike);
    const candidate = estimateP98();
    if (candidate !== undefined && candidate.latency !== metric.value) {
      metric.value = candidate.latency;
      metric.entries = candidate.entries;
      report();
    }
  };

  const observer = observe(env, 'event', handleEntries, { durationThreshold });
  if (observer === undefined) return;
  observe(env, 'first-input', handleEntries); // fallback (no threshold)

  // interactionCount polyfill: when there is no native counter, count ALL interactions (durationThreshold
  // 0) by tracking the interactionId range.
  if (nativeInteractionCount(env) === undefined) {
    observe(
      env,
      'event',
      (entries) => {
        for (const e of entries as EventTimingLike[]) {
          if (e.interactionId) {
            minId = Math.min(minId, e.interactionId);
            maxId = Math.max(maxId, e.interactionId);
          }
        }
      },
      { durationThreshold: 0 },
    );
  }

  onHidden(env, () => {
    handleEntries(observer.takeRecords());
    report(true);
  });
}
