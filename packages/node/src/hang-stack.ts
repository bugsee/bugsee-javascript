import { fileURLToPath } from 'node:url';
import { buildCrashJson, type CrashJson } from '@bugsee/core';
import type { CpuProfile } from './cpu-profiler';

// The blocking stack of a hang (node diagnostics). A hang report carries no stack of its own — the event
// loop was stuck, nothing threw — but V8 keeps sampling during a synchronous block, so the CPU profile taken
// at the report has it. This turns the profile's hottest stack in the stall window into a `crash.json`
// (`exception.frames` + `domain: AppHang::*`), which is what lets the backend group hangs by WHERE they
// block instead of collapsing every hang in an app into one issue.
//
// It goes through the SAME crash builder every other report uses (a synthetic Error whose `stack` is the
// profile's frames in V8's format), so path scrubbing, the runtime-internal/`user` classification and the
// debug-id stamp are not re-implemented here. `handled: true`, as Android's hang report: the process did not crash.

/** Frames kept, leaf end first. Bounds a runaway recursion; the grouping location is at the top anyway. */
const MAX_FRAMES = 64;

/** The profiler's pseudo-frames: time that was not JavaScript in the application. */
const PSEUDO = new Set(['(root)', '(program)', '(idle)', '(garbage collector)']);

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children?: number[];
}

export interface HangCrashOptions {
  /** The trailing slice of the profile to look at, in ms: the measured stall, not older work. */
  windowMs: number;
  /** `AppHang::Fair|Medium|Severe`. */
  domain: string;
  /** The exception reason, e.g. `Event loop blocked for 6000ms`. */
  reason: string;
}

const isNode = (value: unknown): value is ProfileNode => {
  const n = value as Partial<ProfileNode> | null;
  return (
    typeof n === 'object' &&
    n !== null &&
    typeof n.id === 'number' &&
    typeof n.callFrame === 'object' &&
    n.callFrame !== null
  );
};

/**
 * The profiler reports every script as a percent-encoded `file://` URL, CommonJS included, where an
 * `Error.stack` carries the raw filesystem path. Decode it so the frame matches the path an uncaught crash
 * reports (and so the app-root scrub, which matches raw paths, can make it relative).
 */
function filePath(url: string): string {
  if (!url.startsWith('file://')) {
    return url;
  }
  try {
    return fileURLToPath(url);
  } catch {
    return url; // a malformed URL (wrong host, bad escape): keep it as the profiler gave it
  }
}

/** One V8 `at …` line. The profile's line/column are 0-based, a stack's are 1-based. */
function frameLine(frame: ProfileNode['callFrame']): string {
  const name = frame.functionName;
  if (frame.url === '') {
    return `    at ${name} (<anonymous>)`;
  }
  const where = `${filePath(frame.url)}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
  return name === '' ? `    at ${where}` : `    at ${name} (${where})`;
}

/**
 * Is this the application's own code, as opposed to the profiler's pseudo-frames, a native builtin (no script:
 * `JSON.parse`, `sort`, a regex exec) or a runtime module (`node:internal/...`)? A builtin or runtime frame on
 * top would group every hang that ends in the same builtin into one issue whatever called it, so time spent
 * there is attributed to the application frame that called in.
 */
function isApplicationFrame(frame: ProfileNode['callFrame']): boolean {
  return frame.url !== '' && !frame.url.startsWith('node:'); // the pseudo-frames have no script either
}

/** The `id`s of the node's ancestors are not stored, only its children: invert them once. */
function parentsOf(nodes: Map<number, ProfileNode>): Map<number, number> {
  const parents = new Map<number, number>();
  for (const node of nodes.values()) {
    for (const child of node.children ?? []) {
      parents.set(child, node.id);
    }
  }
  return parents;
}

/**
 * The `crash.json` for a hang, from the CPU profile taken at its report; undefined when the profile holds no
 * application stack in the window (nothing sampled, or only idle/program/GC or runtime internals), so the report ships as it does
 * without profiling rather than with an empty crash.
 */
export function hangCrashFromProfile(
  profile: CpuProfile,
  options: HangCrashOptions,
): CrashJson | undefined {
  const { samples, timeDeltas } = profile;
  if (samples === undefined || samples.length === 0) {
    return undefined;
  }
  // A segment restarted after the stall (another collect got there first) holds only what ran since: its hottest
  // frame would be confidently wrong, so a profile that does not span the window yields no crash at all.
  if (profile.endTime - profile.startTime < options.windowMs * 1000) {
    return undefined;
  }
  const nodes = new Map<number, ProfileNode>();
  for (const candidate of profile.nodes) {
    if (isNode(candidate)) {
      nodes.set(candidate.id, candidate);
    }
  }

  const parents = parentsOf(nodes);
  /** The call site a sample's time belongs to: itself, or its nearest ancestor that is application code. */
  const callSite = (start: number): number | undefined => {
    let id: number | undefined = start;
    for (let steps = 0; id !== undefined && steps <= nodes.size; steps += 1) {
      const frame = nodes.get(id)?.callFrame;
      if (frame !== undefined && isApplicationFrame(frame)) {
        return id;
      }
      id = parents.get(id);
    }
    return undefined;
  };

  // Self samples per call site over the trailing window, newest first. `timeDeltas[i]` is the gap before sample
  // i, and the newest sample may itself be older than the profile's end (the loop was idle since).
  const windowUs = options.windowMs * 1000;
  const counts = new Map<number, number>();
  let elapsedUs = 0;
  if (timeDeltas !== undefined) {
    const sampledUs = timeDeltas.reduce((sum, delta) => sum + delta, 0);
    elapsedUs = Math.max(0, profile.endTime - profile.startTime - sampledUs);
  }
  for (let i = samples.length - 1; i >= 0 && elapsedUs < windowUs; i -= 1) {
    const site = callSite(samples[i] as number);
    if (site !== undefined) {
      counts.set(site, (counts.get(site) ?? 0) + 1);
    }
    elapsedUs += timeDeltas?.[i] ?? 0;
  }

  let hottest: number | undefined;
  let most = 0;
  for (const [id, count] of counts) {
    if (count > most) {
      hottest = id;
      most = count;
    }
  }
  if (hottest === undefined) {
    return undefined;
  }

  const lines: string[] = [];
  // Steps are bounded by the node count, so a (malformed) parent cycle through skipped pseudo frames ends too.
  let steps = 0;
  for (
    let id: number | undefined = hottest;
    id !== undefined && lines.length < MAX_FRAMES && steps <= nodes.size;
    id = parents.get(id)
  ) {
    steps += 1;
    const frame = nodes.get(id)?.callFrame;
    if (frame !== undefined && !PSEUDO.has(frame.functionName)) {
      lines.push(frameLine(frame));
    }
  }

  const error = new Error(options.reason);
  error.name = 'AppHang';
  error.stack = `AppHang: ${options.reason}\n${lines.join('\n')}`;
  const crash = buildCrashJson(error, { handled: true });
  crash.exception.domain = options.domain;
  return crash;
}
