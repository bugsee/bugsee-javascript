import { InterceptorBase } from '../interceptor-base';
import { createTrackerRegistry } from '../tracker-registry';
import { hostRead } from './host-read';

// Browser ENVIRONMENT tracker (domain tracker, design §15.3 item 2; Android reference: BugseeTrackerDevice /
// Application). It aggregates what can be OBSERVED about the runtime, in five stages:
//
//   language    {language?, languages?, previous}      navigator.language(s); the `languagechange` window event.
//               CHANGE-ONLY: the first reading is a silent baseline (see `current()`), a later different one emits.
//   timezone    {timeZone?, utcOffsetMinutes?, previous}  Intl time zone id + UTC offset (minutes, positive east).
//               No browser event exists, so it is RE-READ on a slow timer (default 60 s; ticks while the page is hidden
//               are skipped) and on visibility -> visible. CHANGE-ONLY like `language` (a DST shift is an offset change).
//   hints       {cookiesEnabled?, secureContext?, crossOriginIsolated?, serviceWorkerControlled?, automation?,
//               doNotTrack?, globalPrivacyControl?}   SNAPSHOT: emitted for the first reading of this tracker and on
//               every change after it; on a restart the reading is compared with the RETAINED one, so an unchanged
//               reading is not emitted again (read it via `current()`).
//               `automation` is `navigator.webdriver`; `doNotTrack`/`globalPrivacyControl` are the user's own
//               preference signals, recorded as booleans (an unspecified/unknown DNT value is omitted).
//   permissions {camera?: 'granted'|'denied'|'prompt', microphone?, geolocation?, notifications?, 'idle-detection'?}
//               SNAPSHOT of the Permissions API states. Queried WITHOUT EVER PROMPTING: only `navigator.permissions
//               .query()` is called (never requestPermission/getUserMedia/...), only the state STRING is kept (no
//               stream, position or token is ever touched), and a PermissionStatus `change` event refreshes it. Emitted
//               for the first snapshot and on every change; on a restart it is compared with the RETAINED one (same as
//               hints), so an unchanged snapshot is not emitted again (read it via `current()`). A name
//               the browser does not know (query rejects with TypeError) is simply omitted, not an error.
//   privateMode {private: 'yes'|'no'|'unknown', method?}   OFF unless `detectPrivateMode` is set (owner decision
//               pending: detecting private browsing can read as circumventing the user's intent). A HEURISTIC, never a
//               certainty: the only method is `storage-quota` (a quota under 120 MiB suggests a private window, one over
//               1 GiB suggests a normal one, anything between or unreadable is `unknown`; constrained or unusual storage
//               can therefore FALSE-POSITIVE). It emits when the answer first arrives and whenever it changes (it is
//               the basis of the `private_mode_detected` event); a retained yes/no is not probed again on a restart
//               or a seam move, an inconclusive `unknown` is retried.
//
// Every value that is unusable (or that a read found nothing for) is OMITTED, never fabricated; a value whose read
// THREW keeps its retained value (a transient failure is not a change). Host reads go through `hostRead`
// (reported through `onError`, a throwing reporter never escapes) and never fail the launch. Permission-query
// failures are reported once per failure streak.
//
// SINGLETON per key object (see `environmentTrackerFor`). RETENTION rule — what survives the last unsubscribe:
//   * the LAST language / time zone / hints / permissions / private-mode readings (`current()` keeps answering with
//     them, and language / time zone / hints / permissions keep comparing against them when the tracker is
//     restarted: a late subscriber to a restarted tracker gets NO re-emission of an unchanged hints / permissions
//     snapshot — a `privateMode` answer is likewise not repeated unless it changed).
// What does NOT survive: the DOM listeners (languagechange, visibilitychange, PermissionStatus change), the timer, and
// any async work in flight (permission queries, the private-mode probe) — a stale promise is ignored when it settles.
// The next subscriber re-reads everything.

export interface LanguageInfo {
  language?: string;
  languages?: string[];
}
export interface TimeZoneInfo {
  timeZone?: string;
  /** Minutes from UTC, positive east (UTC+2 -> 120). */
  utcOffsetMinutes?: number;
}
export interface EnvironmentHints {
  cookiesEnabled?: boolean;
  secureContext?: boolean;
  crossOriginIsolated?: boolean;
  serviceWorkerControlled?: boolean;
  /** `navigator.webdriver` — the page is driven by automation. */
  automation?: boolean;
  doNotTrack?: boolean;
  globalPrivacyControl?: boolean;
}
export type PermissionStateName = 'granted' | 'denied' | 'prompt';
export type PermissionStates = Record<string, PermissionStateName>;
export interface PrivateModeResult {
  private: 'yes' | 'no' | 'unknown';
  /** The heuristic that produced the answer; absent when nothing could be probed. */
  method?: string;
}
export interface EnvironmentEvents {
  language: LanguageInfo & { previous: LanguageInfo };
  timezone: TimeZoneInfo & { previous: TimeZoneInfo };
  hints: EnvironmentHints;
  permissions: PermissionStates;
  privateMode: PrivateModeResult;
}
export interface EnvironmentSnapshot {
  language?: LanguageInfo;
  timeZone?: TimeZoneInfo;
  hints?: EnvironmentHints;
  permissions?: PermissionStates;
  privateMode?: PrivateModeResult;
}
export interface EnvironmentTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
interface DocumentLike {
  readonly visibilityState?: string;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}
interface TargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** What the tracker needs from a launch (every seam optional; an absent one just means that stage has no data). */
export interface EnvironmentEnv {
  /** Source of `languagechange`, `isSecureContext`, `crossOriginIsolated`. */
  window?: object;
  /** Source of language(s), cookies, webdriver, DNT/GPC, serviceWorker, permissions, storage. */
  navigator?: object;
  /** Source of `visibilitychange` / `visibilityState`. */
  document?: DocumentLike;
  /** Drives the slow time-zone tick; default the global timers. */
  scheduler?: EnvironmentTimers;
  /** Time-zone tick period in ms (default 60 s). */
  intervalMs?: number;
  /** IANA time-zone id; default `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  timeZoneId?: () => unknown;
  /** UTC offset in minutes, positive east; default `-new Date().getTimezoneOffset()`. */
  utcOffsetMinutes?: () => unknown;
  /** Permission names to query (default {@link DEFAULT_PERMISSION_NAMES}). */
  permissionNames?: readonly string[];
  /** Run the private-mode heuristic. Default false (see the header). */
  detectPrivateMode?: boolean;
}

export const DEFAULT_PERMISSION_NAMES: readonly string[] = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'idle-detection',
];
const DEFAULT_INTERVAL_MS = 60_000;
/** A storage quota below this suggests a private window (Chromium gives incognito a small fixed quota). */
export const PRIVATE_QUOTA_BELOW_BYTES = 120 * 1024 * 1024;
/** A storage quota at or above this suggests a normal window. Between the two the answer is `unknown`. */
export const NORMAL_QUOTA_FROM_BYTES = 1024 * 1024 * 1024;
const PRIVATE_MODE_METHOD = 'storage-quota';

const globalScope = globalThis as unknown as {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  Intl: { DateTimeFormat(): { resolvedOptions(): { timeZone?: unknown } } };
  Date: new () => { getTimezoneOffset(): number };
};
const defaultTimers: EnvironmentTimers = {
  setInterval: (cb, ms) => globalScope.setInterval(cb, ms),
  clearInterval: (h) => globalScope.clearInterval(h),
};
const defaultTimeZoneId = (): unknown =>
  globalScope.Intl.DateTimeFormat().resolvedOptions().timeZone;
const defaultUtcOffset = (): unknown => -new globalScope.Date().getTimezoneOffset();

// Key-order-insensitive structural form (objects with sorted keys, arrays in order): two readings holding the same
// values are the same reading however their keys were assembled.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

export class EnvironmentTracker extends InterceptorBase<EnvironmentEvents> {
  readonly name = 'browser-environment';
  #env: EnvironmentEnv;
  /** Bumped on every attach/release: async work from an earlier attachment is ignored. */
  #epoch = 0;
  /** Bumped when the private-mode probe is superseded, cancelled or turned off. */
  #privateEpoch = 0;
  #running = false;
  /** Retained across deactivation (see the retention rule). */
  #language: LanguageInfo | undefined;
  #timeZone: TimeZoneInfo | undefined;
  #hints: EnvironmentHints | undefined;
  #permissions: PermissionStates | undefined;
  #private: PrivateModeResult | undefined;
  /** Failure streak flags (a failure is reported once, until a clean run). */
  #permissionsFailing = false;
  #privateFailing = false;
  /** Streaks of the synchronous stages ('language' | 'timezone' | 'hints' | 'visibility'): reported once each. */
  #failing = new Set<string>();
  #listeners: Array<{ target: Partial<TargetLike>; type: string; listener: () => void }> = [];
  #timer: { handle: unknown; scheduler: EnvironmentTimers } | undefined;
  #statuses: Array<{ status: Partial<TargetLike>; listener: () => void }> = [];

  // Mutable indirection: the SHARED tracker outlives launches, so the reporter is always the latest launch's.
  readonly #report: { fn: ((error: unknown) => void) | undefined };

  constructor(env: EnvironmentEnv, onError?: (error: unknown) => void) {
    const report = { fn: onError };
    // Guarded: a throwing reporter must not escape the emitter's subscriber isolation into a DOM dispatch.
    super((error) => {
      try {
        report.fn?.(error);
      } catch {
        /* the reporter itself failed */
      }
    });
    this.#report = report;
    this.#env = env;
  }

  /**
   * Hand the latest launch's seams to this shared tracker (latest launch wins, but a PARTIAL env never drops what the
   * tracker already has): every defined seam replaces ours, an undefined one keeps it; `detectPrivateMode` (a
   * boolean) replaces whenever defined. A RUNNING tracker whose attached seams (window, navigator, document,
   * scheduler, interval) changed first detaches with the OLD ones, swaps in place, then attaches to the new.
   * Turning `detectPrivateMode` on while running probes right away; turning it off drops the result.
   */
  rebind(env: EnvironmentEnv, onError?: (error: unknown) => void): void {
    if (onError !== undefined) this.#report.fn = onError;
    const old = this.#env;
    const next = seamsOf(env, old, (e) => this.#onError(e));
    const moved =
      next.window !== old.window ||
      next.navigator !== old.navigator ||
      next.document !== old.document ||
      next.scheduler !== old.scheduler ||
      next.intervalMs !== old.intervalMs;
    const privateTurnedOn = next.detectPrivateMode === true && old.detectPrivateMode !== true;
    const privateTurnedOff = next.detectPrivateMode !== true && old.detectPrivateMode === true;
    if (moved && this.#running) this.#release(); // OLD seams
    this.#env = next;
    if (privateTurnedOff) {
      this.#privateEpoch += 1;
      this.#private = undefined;
    }
    if (!this.#running) return;
    if (moved) this.#attach();
    else if (privateTurnedOn) this.#detectPrivateMode();
  }

  #onError(error: unknown): void {
    try {
      this.#report.fn?.(error);
    } catch {
      /* the reporter itself failed */
    }
  }

  /** The latest readings (each omitted until read). Retained after the last unsubscribe. */
  current(): EnvironmentSnapshot {
    return {
      ...(this.#language !== undefined ? { language: this.#language } : {}),
      ...(this.#timeZone !== undefined ? { timeZone: this.#timeZone } : {}),
      ...(this.#hints !== undefined ? { hints: this.#hints } : {}),
      ...(this.#permissions !== undefined ? { permissions: this.#permissions } : {}),
      ...(this.#private !== undefined ? { privateMode: this.#private } : {}),
    };
  }

  /** Test/teardown: forget every reading, release listeners and timer, ignore anything in flight. */
  reset(): void {
    this.removeAllListeners(); // drops every subscriber: the base deactivates, so a NEW subscriber re-activates us
    this.#running = false;
    this.#release();
    this.#language = undefined;
    this.#timeZone = undefined;
    this.#hints = undefined;
    this.#permissions = undefined;
    this.#private = undefined;
    this.#permissionsFailing = false;
    this.#privateFailing = false;
    this.#failing.clear();
  }

  protected onActivate(): void {
    this.#running = true;
    this.#attach();
  }

  protected override onDeactivate(): void {
    this.#running = false;
    this.#release(); // readings are retained
  }

  #attach(): void {
    this.#epoch += 1;
    this.#listen(asTarget(this.#env.window), 'languagechange', () => this.#publishLanguage());
    this.#listen(asTarget(this.#env.document), 'visibilitychange', () => {
      if (this.#visibility() === 'visible') this.#refresh();
    });
    this.#arm();
    this.#refresh();
    this.#queryPermissions();
    this.#detectPrivateMode();
  }

  /**
   * Runs one synchronous host read through a reporter that is quiet while the failure persists: the first failing run
   * of a streak reports (every error of it), later failing runs say nothing, and a clean run ends the streak.
   */
  #streak<T>(key: string, read: (report: (error: unknown) => void) => T): T {
    const errors: unknown[] = [];
    const result = read((error) => void errors.push(error));
    if (errors.length === 0) this.#failing.delete(key);
    else if (!this.#failing.has(key)) {
      this.#failing.add(key);
      for (const error of errors) this.#onError(error);
    }
    return result;
  }

  #visibility(): unknown {
    return this.#streak('visibility', (report) =>
      hostRead(() => this.#env.document?.visibilityState, report),
    );
  }

  /**
   * One host read of a multi-field reading: a read that THREW keeps the retained value of that field (a failing field
   * must not turn into a fake change); one that merely found nothing (undefined) omits it.
   */
  #field<T>(
    report: (error: unknown) => void,
    read: () => T,
    retained: T | undefined,
  ): T | undefined {
    let failed = false;
    const value = hostRead(read, (error) => {
      failed = true;
      report(error);
    });
    return failed ? retained : value;
  }

  #listen(target: Partial<TargetLike> | undefined, type: string, run: () => void): void {
    if (target === undefined) return;
    // The READ can throw too (a cross-origin WindowProxy): reported, and the others still attach.
    const add = hostRead(
      () => target.addEventListener,
      (e) => this.#onError(e),
    );
    if (typeof add !== 'function') return;
    const listener = (): void => {
      try {
        run();
      } catch (error) /* v8 ignore next 3 -- defense in depth: every read and the emitter are already guarded */ {
        this.#onError(error);
      }
    };
    // Recorded BEFORE attaching so a failing addEventListener still leaves a removable record.
    this.#listeners.push({ target, type, listener });
    try {
      add.call(target, type, listener);
    } catch (error) {
      this.#onError(error);
    }
  }

  #arm(): void {
    try {
      const scheduler = this.#env.scheduler ?? defaultTimers;
      const handle = scheduler.setInterval(() => {
        try {
          // A hidden page is not re-read (visibility -> visible re-reads on return).
          if (this.#visibility() !== 'hidden') this.#refresh();
        } catch (error) {
          this.#onError(error);
        }
      }, this.#env.intervalMs ?? DEFAULT_INTERVAL_MS);
      this.#timer = { handle, scheduler };
    } catch (error) {
      this.#onError(error);
    }
  }

  /** Listeners, timer, status listeners; invalidates async work in flight. Best-effort throughout. */
  #release(): void {
    this.#epoch += 1;
    this.#privateEpoch += 1;
    const listeners = this.#listeners;
    this.#listeners = [];
    for (const { target, type, listener } of listeners) {
      try {
        target.removeEventListener?.(type, listener);
      } catch {
        /* best-effort: one detached target must not leak the others */
      }
    }
    this.#releaseStatuses();
    const timer = this.#timer;
    this.#timer = undefined;
    if (timer !== undefined) {
      try {
        timer.scheduler.clearInterval(timer.handle);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  #releaseStatuses(): void {
    const statuses = this.#statuses;
    this.#statuses = [];
    for (const { status, listener } of statuses) {
      try {
        status.removeEventListener?.('change', listener);
      } catch {
        /* best-effort */
      }
    }
  }

  // ---- synchronous stages: language, timezone, hints ----

  #refresh(): void {
    this.#publishLanguage();
    this.#publishTimeZone();
    this.#publishHints();
  }

  #readLanguage(report: (error: unknown) => void): LanguageInfo | undefined {
    const nav = this.#env.navigator as { language?: unknown; languages?: unknown } | undefined;
    if (nav === undefined) return undefined;
    const kept = this.#language;
    const language = nonEmpty(this.#field(report, () => nav.language, kept?.language));
    const languages = this.#field<string[] | undefined>(
      report,
      () => {
        const raw = nav.languages;
        return Array.isArray(raw) ? raw.filter((l) => nonEmpty(l) !== undefined) : undefined;
      },
      kept?.languages,
    );
    const info: LanguageInfo = {
      ...(language !== undefined ? { language } : {}),
      ...(languages !== undefined && languages.length > 0 ? { languages } : {}),
    };
    return Object.keys(info).length === 0 ? undefined : info;
  }

  #publishLanguage(): void {
    const next = this.#streak('language', (report) => this.#readLanguage(report));
    if (next === undefined) return; // nothing readable: keep what we have, say nothing
    const previous = this.#language;
    this.#language = next;
    if (previous !== undefined && !same(previous, next)) {
      this.emit('language', { ...copyLanguage(next), previous: copyLanguage(previous) });
    }
  }

  #readTimeZone(report: (error: unknown) => void): TimeZoneInfo | undefined {
    const kept = this.#timeZone;
    const timeZone = nonEmpty(
      this.#field(report, this.#env.timeZoneId ?? defaultTimeZoneId, kept?.timeZone),
    );
    const offset = this.#field(
      report,
      this.#env.utcOffsetMinutes ?? defaultUtcOffset,
      kept?.utcOffsetMinutes,
    );
    const utcOffsetMinutes =
      typeof offset === 'number' && Number.isFinite(offset) ? offset + 0 : undefined; // -0 -> 0
    const info: TimeZoneInfo = {
      ...(timeZone !== undefined ? { timeZone } : {}),
      ...(utcOffsetMinutes !== undefined ? { utcOffsetMinutes } : {}),
    };
    return Object.keys(info).length === 0 ? undefined : info;
  }

  #publishTimeZone(): void {
    const next = this.#streak('timezone', (report) => this.#readTimeZone(report));
    if (next === undefined) return;
    const previous = this.#timeZone;
    this.#timeZone = next;
    if (previous !== undefined && !same(previous, next)) {
      this.emit('timezone', { ...next, previous });
    }
  }

  #readHints(report: (error: unknown) => void): EnvironmentHints | undefined {
    const nav = this.#env.navigator as Record<string, unknown> | undefined;
    const win = this.#env.window as Record<string, unknown> | undefined;
    const kept = this.#hints;
    // A read that threw keeps the retained value of its hint (see #field).
    const flag = (
      source: Record<string, unknown> | undefined,
      key: string,
      hint: keyof EnvironmentHints,
    ): boolean | undefined =>
      bool(this.#field(report, () => source?.[key], kept?.[hint] as boolean | undefined));
    const cookiesEnabled = flag(nav, 'cookieEnabled', 'cookiesEnabled');
    const secureContext = flag(win, 'isSecureContext', 'secureContext');
    const crossOriginIsolated = flag(win, 'crossOriginIsolated', 'crossOriginIsolated');
    const automation = flag(nav, 'webdriver', 'automation');
    const globalPrivacyControl = flag(nav, 'globalPrivacyControl', 'globalPrivacyControl');
    const doNotTrack = this.#field<boolean | undefined>(
      report,
      () => {
        const dnt = nav?.doNotTrack;
        return dnt === '1' || dnt === 'yes'
          ? true
          : dnt === '0' || dnt === 'no'
            ? false
            : undefined;
      },
      kept?.doNotTrack,
    );
    // Only a browser that HAS a service-worker container can say whether the page is controlled.
    const serviceWorkerControlled = this.#field<boolean | undefined>(
      report,
      () => {
        const container = nav?.serviceWorker as { controller?: unknown } | undefined;
        return typeof container === 'object' && container !== null
          ? container.controller !== null && container.controller !== undefined
          : undefined;
      },
      kept?.serviceWorkerControlled,
    );
    const hints: EnvironmentHints = {
      ...(cookiesEnabled !== undefined ? { cookiesEnabled } : {}),
      ...(secureContext !== undefined ? { secureContext } : {}),
      ...(crossOriginIsolated !== undefined ? { crossOriginIsolated } : {}),
      ...(serviceWorkerControlled !== undefined ? { serviceWorkerControlled } : {}),
      ...(automation !== undefined ? { automation } : {}),
      ...(doNotTrack !== undefined ? { doNotTrack } : {}),
      ...(globalPrivacyControl !== undefined ? { globalPrivacyControl } : {}),
    };
    return Object.keys(hints).length === 0 ? undefined : hints;
  }

  #publishHints(): void {
    const next = this.#streak('hints', (report) => this.#readHints(report));
    if (next === undefined) return;
    const changed = !same(this.#hints, next);
    this.#hints = next;
    if (changed) this.emit('hints', { ...next });
  }

  // ---- permissions (never prompts) ----

  #queryPermissions(): void {
    const mine = this.#epoch;
    const report = (e: unknown): void => this.#onError(e);
    const permissions = hostRead(
      () => (this.#env.navigator as { permissions?: unknown } | undefined)?.permissions,
      report,
    ) as { query?: (descriptor: { name: string }) => Promise<unknown> } | undefined;
    if (typeof permissions !== 'object' || permissions === null) return;
    const query = hostRead(() => permissions.query, report);
    if (typeof query !== 'function') return;
    const names = this.#env.permissionNames ?? DEFAULT_PERMISSION_NAMES;
    const errors: unknown[] = [];
    const failedNames = new Set<string>(); // names whose query FAILED (a fault): their retained state is kept
    const fail =
      (name: string) =>
      (error: unknown): undefined => {
        // An unknown permission NAME rejects with TypeError: that is "unsupported here", not a fault.
        if (hostRead(() => (error as { name?: unknown }).name) !== 'TypeError') {
          errors.push(error);
          failedNames.add(name);
        }
        return undefined;
      };
    const ask = (name: string): Promise<{ name: string; status: unknown } | undefined> => {
      try {
        return Promise.resolve(query.call(permissions, { name })).then(
          (status) => ({ name, status }),
          fail(name),
        );
      } catch (error) {
        return Promise.resolve(fail(name)(error));
      }
    };
    void Promise.all(names.map(ask)).then((results) => {
      if (this.#epoch !== mine) return; // released or re-attached while in flight
      if (errors.length === 0) this.#permissionsFailing = false;
      else if (!this.#permissionsFailing) {
        this.#permissionsFailing = true;
        for (const error of errors) this.#onError(error);
      }
      const answered = results.filter(
        (r): r is { name: string; status: unknown } => r !== undefined,
      );
      for (const { name, status } of answered) this.#watchStatus(name, status, mine);
      this.#publishPermissions(answered, failedNames);
    });
  }

  /** `threw`: the read itself failed (keep the retained state); `state` undefined otherwise = unusable (omit). */
  #readState(
    name: string,
    status: unknown,
  ): { state: PermissionStateName | undefined; threw: boolean } {
    let threw = false;
    const state = this.#streak(`permission:${name}`, (report) =>
      hostRead(
        () => (status as { state?: unknown }).state,
        (error) => {
          threw = true;
          report(error);
        },
      ),
    );
    return {
      state: state === 'granted' || state === 'denied' || state === 'prompt' ? state : undefined,
      threw,
    };
  }

  #watchStatus(name: string, status: unknown, mine: number): void {
    const target = asTarget(status);
    if (target === undefined) return;
    const listener = (): void => {
      if (this.#epoch !== mine) return;
      try {
        const { state, threw } = this.#readState(name, status);
        if (threw) return; // a failed read is not a change: keep what we have
        const next: PermissionStates = { ...this.#permissions };
        if (state === undefined)
          delete next[name]; // unusable now: omit, never keep a stale claim
        else next[name] = state;
        this.#commitPermissions(next);
      } catch (error) {
        this.#onError(error); // a DOM dispatch must never see a throw
      }
    };
    const add = hostRead(
      () => target.addEventListener,
      (e) => this.#onError(e),
    );
    if (typeof add !== 'function') return;
    this.#statuses.push({ status: target, listener });
    try {
      add.call(target, 'change', listener);
    } catch (error) {
      this.#onError(error);
    }
  }

  #publishPermissions(
    answered: Array<{ name: string; status: unknown }>,
    failedNames: ReadonlySet<string>,
  ): void {
    const next: PermissionStates = {};
    const kept = this.#permissions;
    for (const { name, status } of answered) {
      const { state, threw } = this.#readState(name, status);
      const value = threw ? kept?.[name] : state;
      if (value !== undefined) next[name] = value;
    }
    for (const name of failedNames) {
      const value = kept?.[name]; // the query failed: keep the retained state of that name
      if (value !== undefined) next[name] = value;
    }
    // Nothing usable (unsupported / every query failed): keep the retained snapshot, emit nothing.
    if (Object.keys(next).length === 0) return;
    this.#commitPermissions(next);
  }

  #commitPermissions(next: PermissionStates): void {
    const changed = !same(this.#permissions, next);
    this.#permissions = next;
    if (changed) this.emit('permissions', { ...next });
  }

  // ---- private mode (opt-in heuristic) ----

  #detectPrivateMode(): void {
    if (this.#env.detectPrivateMode !== true) return;
    // A retained yes/no is not probed again (it does not change within a page); an inconclusive one is retried.
    if (this.#private?.private === 'yes' || this.#private?.private === 'no') return;
    const mine = ++this.#privateEpoch;
    const report = (e: unknown): void => this.#onError(e);
    const storage = hostRead(
      () => (this.#env.navigator as { storage?: unknown } | undefined)?.storage,
      report,
    ) as { estimate?: () => Promise<{ quota?: unknown }> } | undefined;
    const estimate =
      typeof storage === 'object' && storage !== null
        ? hostRead(() => storage.estimate, report)
        : undefined;
    if (typeof estimate !== 'function') {
      this.#settlePrivate({ private: 'unknown' });
      return;
    }
    let pending: Promise<{ quota?: unknown }>;
    try {
      pending = Promise.resolve(estimate.call(storage));
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending.then(
      (raw) => {
        if (this.#privateEpoch !== mine) return;
        this.#privateFailing = false;
        const quota = hostRead(() => raw?.quota, report);
        this.#settlePrivate(classifyQuota(quota));
      },
      (error: unknown) => {
        if (this.#privateEpoch !== mine) return;
        if (!this.#privateFailing) {
          this.#privateFailing = true;
          this.#onError(error);
        }
        this.#settlePrivate({ private: 'unknown' });
      },
    );
  }

  #settlePrivate(result: PrivateModeResult): void {
    const changed = !same(this.#private, result);
    this.#private = result;
    if (changed) this.emit('privateMode', { ...result });
  }
}

function classifyQuota(quota: unknown): PrivateModeResult {
  if (typeof quota !== 'number' || !Number.isFinite(quota) || quota <= 0) {
    return { private: 'unknown' };
  }
  if (quota < PRIVATE_QUOTA_BELOW_BYTES) return { private: 'yes', method: PRIVATE_MODE_METHOD };
  if (quota >= NORMAL_QUOTA_FROM_BYTES) return { private: 'no', method: PRIVATE_MODE_METHOD };
  return { private: 'unknown', method: PRIVATE_MODE_METHOD };
}

// Copied on every payload: a kept (failed-read) field shares its array between the old and the new reading.
function copyLanguage(info: LanguageInfo): LanguageInfo {
  return { ...info, ...(info.languages !== undefined ? { languages: [...info.languages] } : {}) };
}

function asTarget(value: unknown): Partial<TargetLike> | undefined {
  return typeof value === 'object' && value !== null ? (value as Partial<TargetLike>) : undefined;
}

/** `{[key]: next[key]}` when defined, else the previous value (if any), else nothing. */
function pick<K extends keyof EnvironmentEnv>(
  next: EnvironmentEnv,
  previous: EnvironmentEnv,
  key: K,
  onError?: (error: unknown) => void,
): Pick<EnvironmentEnv, K> {
  const value = hostRead(() => next[key], onError) ?? previous[key]; // a hostile env getter is reported, not thrown
  return (value !== undefined ? { [key]: value } : {}) as Pick<EnvironmentEnv, K>;
}

/** Every seam of `env`, each falling back to `previous` when `env` has none. */
function seamsOf(
  env: EnvironmentEnv,
  previous: EnvironmentEnv = {},
  onError?: (error: unknown) => void,
): EnvironmentEnv {
  return {
    ...pick(env, previous, 'window', onError),
    ...pick(env, previous, 'navigator', onError),
    ...pick(env, previous, 'document', onError),
    ...pick(env, previous, 'scheduler', onError),
    ...pick(env, previous, 'intervalMs', onError),
    ...pick(env, previous, 'timeZoneId', onError),
    ...pick(env, previous, 'utcOffsetMinutes', onError),
    ...pick(env, previous, 'permissionNames', onError),
    ...pick(env, previous, 'detectPrivateMode', onError),
  };
}

const registry = createTrackerRegistry<EnvironmentTracker>();

// The key is the window the SDK is bound to; failing that the navigator; failing that the env object itself (an
// ad-hoc env then gets a private tracker). Host reads are guarded AND reported.
function keyFrom(env: EnvironmentEnv, win: unknown, nav: unknown): object {
  if (typeof win === 'object' && win !== null) return win;
  if (typeof nav === 'object' && nav !== null) return nav;
  return env;
}
function keyOf(env: EnvironmentEnv, onError?: (error: unknown) => void): object {
  return keyFrom(
    env,
    hostRead(() => env.window, onError),
    hostRead(() => env.navigator, onError),
  );
}

/**
 * The singleton EnvironmentTracker for the env's window. Every call (a relaunch included) hands the shared tracker
 * the latest launch's `onError` and seams (see {@link EnvironmentTracker.rebind}).
 */
export function environmentTrackerFor(
  env: EnvironmentEnv,
  onError?: (error: unknown) => void,
): EnvironmentTracker {
  // window/navigator are read ONCE (by seamsOf); the registry key is derived from those same readings.
  const seams = seamsOf(env, {}, onError);
  return registry.for(
    keyFrom(env, seams.window, seams.navigator),
    () => new EnvironmentTracker(seams, onError),
    (tracker) => tracker.rebind(seams, onError),
  );
}

/** Test/teardown: drop the env's tracker (resetting it, so its listeners and timer are released). */
export function resetEnvironmentTracker(env: EnvironmentEnv): void {
  registry.reset(keyOf(env));
}
