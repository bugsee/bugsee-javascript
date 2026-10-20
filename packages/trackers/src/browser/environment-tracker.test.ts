import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PERMISSION_NAMES,
  type EnvironmentEnv,
  type EnvironmentEvents,
  type EnvironmentTimers,
  EnvironmentTracker,
  environmentTrackerFor,
  NORMAL_QUOTA_FROM_BYTES,
  PRIVATE_QUOTA_BELOW_BYTES,
  resetEnvironmentTracker,
} from './environment-tracker';

const flush = (): Promise<void> =>
  new Promise((r) =>
    (globalThis as unknown as { setTimeout(f: () => void, ms: number): void }).setTimeout(
      () => r(),
      0,
    ),
  );

function mkTarget(extra: Record<string, unknown> = {}) {
  const l = new Map<string, Set<() => void>>();
  return Object.assign(
    {
      addEventListener: (t: string, f: () => void) => {
        const s = l.get(t) ?? new Set<() => void>();
        s.add(f);
        l.set(t, s);
      },
      removeEventListener: (t: string, f: () => void) => void l.get(t)?.delete(f),
      fire: (t: string) => {
        for (const f of [...(l.get(t) ?? [])]) f();
      },
      count: (t?: string) =>
        t === undefined ? [...l.values()].reduce((n, s) => n + s.size, 0) : (l.get(t)?.size ?? 0),
    },
    extra,
  );
}

function mkScheduler() {
  let next = 1;
  const live = new Map<number, () => void>();
  const scheduler: EnvironmentTimers & { live: typeof live; tick(): void; periods: number[] } = {
    live,
    periods: [],
    setInterval(cb, ms) {
      const id = next++;
      live.set(id, cb);
      scheduler.periods.push(ms);
      return id;
    },
    clearInterval(h) {
      live.delete(h as number);
    },
    tick() {
      for (const cb of [...live.values()]) cb();
    },
  };
  return scheduler;
}

const mkDocument = (state = 'visible') => mkTarget({ visibilityState: state });

function mkStatus(state: string) {
  return mkTarget({ state });
}
function mkPermissions(states: Record<string, string | Error>) {
  const statuses = new Map<string, ReturnType<typeof mkStatus>>();
  const query = vi.fn(({ name }: { name: string }) => {
    const s = states[name];
    if (s === undefined) return Promise.reject(Object.assign(new TypeError('bad name'), {}));
    if (s instanceof Error) return Promise.reject(s);
    const status = mkStatus(s);
    statuses.set(name, status);
    return Promise.resolve(status);
  });
  return { query, statuses };
}

const wins: object[] = [];
function setup(
  nav: Record<string, unknown> = { language: 'en-US', languages: ['en-US', 'en'] },
  env: Partial<EnvironmentEnv> = {},
) {
  const win = mkTarget({ isSecureContext: true, crossOriginIsolated: false });
  wins.push(win);
  const document = mkDocument();
  const scheduler = mkScheduler();
  const zone = { id: 'Europe/Kyiv', offset: 120 };
  const onError = vi.fn();
  const navigator = nav;
  const tracker = new EnvironmentTracker(
    {
      window: win,
      navigator,
      document,
      scheduler,
      intervalMs: 777,
      timeZoneId: () => zone.id,
      utcOffsetMinutes: () => zone.offset,
      // the tracker reads hints / queries permissions only when asked: most tests are about those stages
      observeHints: true,
      queryPermissions: true,
      ...env,
    },
    onError,
  );
  const seen: Array<[keyof EnvironmentEvents, unknown]> = [];
  const listen = (): (() => void) => tracker.onAny((n, p) => seen.push([n, p]));
  return { tracker, win, document, scheduler, zone, onError, navigator, seen, listen };
}
afterEach(() => {
  for (const w of wins.splice(0)) resetEnvironmentTracker({ window: w });
});

describe('EnvironmentTracker: language', () => {
  it('does nothing at construction; the first reading is a silent baseline in current()', () => {
    const { tracker, win, scheduler, seen, listen } = setup();
    expect(win.count()).toBe(0);
    expect(scheduler.live.size).toBe(0);
    expect(tracker.current()).toEqual({});
    listen();
    expect(tracker.current().language).toEqual({ language: 'en-US', languages: ['en-US', 'en'] });
    expect(seen.filter(([n]) => n === 'language')).toEqual([]);
    expect(win.count('languagechange')).toBe(1);
  });

  it('emits language {…, previous} on languagechange and not when nothing changed', () => {
    const { tracker, win, navigator, seen, listen } = setup();
    listen();
    win.fire('languagechange');
    expect(seen.filter(([n]) => n === 'language')).toEqual([]);
    navigator.language = 'uk-UA';
    navigator.languages = ['uk-UA'];
    win.fire('languagechange');
    expect(seen.filter(([n]) => n === 'language')).toEqual([
      [
        'language',
        {
          language: 'uk-UA',
          languages: ['uk-UA'],
          previous: { language: 'en-US', languages: ['en-US', 'en'] },
        },
      ],
    ]);
    expect(tracker.current().language).toEqual({ language: 'uk-UA', languages: ['uk-UA'] });
  });

  it('omits unusable values: non-strings, empty strings, empty lists, non-arrays', () => {
    const a = setup({ language: '', languages: [] });
    a.listen();
    expect(a.tracker.current().language).toBeUndefined();
    const b = setup({ language: 5, languages: 'en' });
    b.listen();
    expect(b.tracker.current().language).toBeUndefined();
    const c = setup({ language: 'de', languages: ['', 3, 'de'] });
    c.listen();
    expect(c.tracker.current().language).toEqual({ language: 'de', languages: ['de'] });
    const d = new EnvironmentTracker({ navigator: undefined, scheduler: mkScheduler() });
    d.on('language', () => {});
    expect(d.current().language).toBeUndefined();
  });

  it('an unreadable value keeps the retained reading and emits nothing', () => {
    const { tracker, win, navigator, seen, listen } = setup();
    listen();
    navigator.language = undefined;
    navigator.languages = undefined;
    win.fire('languagechange');
    expect(seen.filter(([n]) => n === 'language')).toEqual([]);
    expect(tracker.current().language?.language).toBe('en-US');
  });

  it('a throwing getter is reported and costs only that field', () => {
    const nav = {
      get language(): string {
        throw new Error('lang');
      },
      languages: ['fr'],
    };
    const { tracker, onError, listen } = setup(nav as never);
    listen();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(tracker.current().language).toEqual({ languages: ['fr'] });
    const nav2 = {
      language: 'fr',
      get languages(): string[] {
        throw new Error('langs');
      },
    };
    const b = setup(nav2 as never);
    b.listen();
    expect(b.onError).toHaveBeenCalledTimes(1);
    expect(b.tracker.current().language).toEqual({ language: 'fr' });
  });
});

describe('EnvironmentTracker: timezone', () => {
  it('reads the zone + offset silently, then emits on a tick when either changes', () => {
    const { tracker, scheduler, zone, seen, listen } = setup();
    listen();
    expect(tracker.current().timeZone).toEqual({ timeZone: 'Europe/Kyiv', utcOffsetMinutes: 120 });
    expect(scheduler.periods).toEqual([777]);
    scheduler.tick();
    expect(seen.filter(([n]) => n === 'timezone')).toEqual([]);
    zone.offset = 180; // DST
    scheduler.tick();
    zone.id = 'Asia/Tokyo';
    zone.offset = 540;
    scheduler.tick();
    expect(seen.filter(([n]) => n === 'timezone')).toEqual([
      [
        'timezone',
        {
          timeZone: 'Europe/Kyiv',
          utcOffsetMinutes: 180,
          previous: { timeZone: 'Europe/Kyiv', utcOffsetMinutes: 120 },
        },
      ],
      [
        'timezone',
        {
          timeZone: 'Asia/Tokyo',
          utcOffsetMinutes: 540,
          previous: { timeZone: 'Europe/Kyiv', utcOffsetMinutes: 180 },
        },
      ],
    ]);
  });

  it('re-reads on visibility -> visible only (not on hidden)', () => {
    const { document, zone, seen, listen } = setup();
    listen();
    zone.offset = 60;
    document.visibilityState = 'hidden';
    document.fire('visibilitychange');
    expect(seen.filter(([n]) => n === 'timezone')).toEqual([]);
    document.visibilityState = 'visible';
    document.fire('visibilitychange');
    expect(seen.filter(([n]) => n === 'timezone')).toHaveLength(1);
  });

  it('skips ticks while the page is hidden', () => {
    const { document, scheduler, zone, seen, listen } = setup();
    listen();
    document.visibilityState = 'hidden';
    zone.offset = 60;
    scheduler.tick();
    expect(seen.filter(([n]) => n === 'timezone')).toEqual([]);
    document.visibilityState = 'visible';
    scheduler.tick();
    expect(seen.filter(([n]) => n === 'timezone')).toHaveLength(1);
  });

  it('normalizes -0, omits unusable offsets/ids, never fabricates', () => {
    const a = setup(undefined, { utcOffsetMinutes: () => -0 });
    a.listen();
    expect(Object.is(a.tracker.current().timeZone?.utcOffsetMinutes, 0)).toBe(true);
    const b = setup(undefined, { utcOffsetMinutes: () => Number.NaN, timeZoneId: () => '' });
    b.listen();
    expect(b.tracker.current().timeZone).toBeUndefined();
    const c = setup(undefined, { utcOffsetMinutes: () => '120', timeZoneId: () => 7 });
    c.listen();
    expect(c.tracker.current().timeZone).toBeUndefined();
  });

  it('a throwing reader is reported and costs only its field', () => {
    const a = setup(undefined, {
      timeZoneId: () => {
        throw new Error('tz');
      },
    });
    a.listen();
    expect(a.onError).toHaveBeenCalledTimes(1);
    expect(a.tracker.current().timeZone).toEqual({ utcOffsetMinutes: 120 });
  });

  it('defaults to Intl + Date and the global timers when no seam is injected', () => {
    vi.useFakeTimers();
    try {
      const t = new EnvironmentTracker({ intervalMs: 50 });
      const off = t.on('timezone', () => {});
      const tz = t.current().timeZone;
      expect(tz?.timeZone).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(tz?.utcOffsetMinutes).toBe(-new Date().getTimezoneOffset() + 0);
      expect(vi.getTimerCount()).toBe(1);
      off();
      expect(vi.getTimerCount()).toBe(0);
      let offset = 0;
      const d = new EnvironmentTracker({ timeZoneId: () => 'UTC', utcOffsetMinutes: () => offset });
      const changes: unknown[] = [];
      d.on('timezone', (e) => changes.push(e));
      expect(vi.getTimerCount()).toBe(1);
      offset = 60;
      vi.advanceTimersByTime(59_999);
      expect(changes).toEqual([]); // not before the default 60 s period
      vi.advanceTimersByTime(1);
      expect(changes).toEqual([
        {
          timeZone: 'UTC',
          utcOffsetMinutes: 60,
          previous: { timeZone: 'UTC', utcOffsetMinutes: 0 },
        },
      ]);
      d.reset();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('EnvironmentTracker: hints', () => {
  const nav = () => ({
    language: 'en',
    cookieEnabled: true,
    webdriver: false,
    doNotTrack: '1',
    globalPrivacyControl: true,
    serviceWorker: { controller: {} },
  });

  it('emits every available hint on the first reading', () => {
    const { tracker, seen, listen } = setup(nav());
    listen();
    const expected = {
      cookiesEnabled: true,
      secureContext: true,
      crossOriginIsolated: false,
      serviceWorkerControlled: true,
      automation: false,
      doNotTrack: true,
      globalPrivacyControl: true,
    };
    expect(seen.filter(([n]) => n === 'hints')).toEqual([['hints', expected]]);
    expect(tracker.current().hints).toEqual(expected);
  });

  it('maps DNT values and omits unspecified ones; no service-worker container -> omitted', () => {
    for (const [raw, want] of [
      ['1', true],
      ['yes', true],
      ['0', false],
      ['no', false],
    ] as const) {
      const s = setup({ doNotTrack: raw });
      s.listen();
      expect(s.tracker.current().hints?.doNotTrack).toBe(want);
    }
    for (const raw of ['unspecified', null, undefined, 1]) {
      const s = setup({ doNotTrack: raw, cookieEnabled: true });
      s.listen();
      expect(s.tracker.current().hints).not.toHaveProperty('doNotTrack');
      expect(s.tracker.current().hints).not.toHaveProperty('serviceWorkerControlled');
    }
    const s = setup({ serviceWorker: { controller: null } });
    s.listen();
    expect(s.tracker.current().hints?.serviceWorkerControlled).toBe(false);
    const u = setup({ serviceWorker: { controller: undefined } });
    u.listen();
    expect(u.tracker.current().hints?.serviceWorkerControlled).toBe(false);
  });

  it('omits non-boolean values; a tracker with no readable hint has none', () => {
    const s = setup({ cookieEnabled: 'yes', webdriver: 1, globalPrivacyControl: 'true' });
    s.listen();
    expect(s.tracker.current().hints).toEqual({ secureContext: true, crossOriginIsolated: false });
    const bare = new EnvironmentTracker({ navigator: {}, window: {}, scheduler: mkScheduler() });
    bare.on('hints', () => {});
    expect(bare.current().hints).toBeUndefined();
  });

  it('emits again only when a hint changes (tick / visibility)', () => {
    const n = nav();
    const { document, scheduler, seen, listen } = setup(n);
    listen();
    scheduler.tick();
    expect(seen.filter(([k]) => k === 'hints')).toHaveLength(1);
    n.serviceWorker = { controller: null as never };
    document.fire('visibilitychange');
    const hints = seen.filter(([k]) => k === 'hints');
    expect(hints).toHaveLength(2);
    expect((hints[1]?.[1] as { serviceWorkerControlled: boolean }).serviceWorkerControlled).toBe(
      false,
    );
  });

  it('a throwing getter is reported and costs only that hint', () => {
    const throwing = {
      get cookieEnabled(): boolean {
        throw new Error('cookie');
      },
      webdriver: true,
      get serviceWorker(): unknown {
        throw new Error('sw');
      },
    };
    const { tracker, onError, listen } = setup(throwing);
    listen();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(tracker.current().hints).toEqual({
      secureContext: true,
      crossOriginIsolated: false,
      automation: true,
    });
  });
});

describe('EnvironmentTracker: permissions', () => {
  it('queries only the default names, never prompts, emits states and refreshes on status change', async () => {
    const perms = mkPermissions({
      camera: 'denied',
      microphone: 'prompt',
      geolocation: 'granted',
      notifications: 'granted',
      'idle-detection': 'prompt',
    });
    const requestPermission = vi.fn();
    const getUserMedia = vi.fn();
    const { tracker, seen, listen } = setup({
      permissions: perms,
      requestPermission,
      mediaDevices: { getUserMedia },
    });
    listen();
    expect(perms.query.mock.calls.map((c) => c[0])).toEqual(
      DEFAULT_PERMISSION_NAMES.map((name) => ({ name })),
    );
    await flush();
    const expected = {
      camera: 'denied',
      microphone: 'prompt',
      geolocation: 'granted',
      notifications: 'granted',
      'idle-detection': 'prompt',
    };
    expect(seen.filter(([n]) => n === 'permissions')).toEqual([['permissions', expected]]);
    expect(tracker.current().permissions).toEqual(expected);
    // the user grants the camera in the browser UI
    const cam = perms.statuses.get('camera');
    if (cam === undefined) throw new Error('no status');
    cam.state = 'granted';
    cam.fire('change');
    expect(seen.filter(([n]) => n === 'permissions')[1]).toEqual([
      'permissions',
      { ...expected, camera: 'granted' },
    ]);
    // a no-op change does not emit
    cam.fire('change');
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(2);
    // an unreadable state is omitted, not kept
    cam.state = 'weird';
    cam.fire('change');
    expect(tracker.current().permissions).not.toHaveProperty('camera');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('a name the browser rejects with TypeError is omitted silently; other failures are reported once per streak', async () => {
    const boom = new Error('denied by policy');
    const perms = mkPermissions({ camera: 'granted', microphone: boom });
    const { tracker, onError, listen } = setup(
      { permissions: perms },
      { permissionNames: ['camera', 'microphone', 'unknown-name'] },
    );
    const off = listen();
    await flush();
    expect(tracker.current().permissions).toEqual({ camera: 'granted' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
    // a second activation while still failing does not report again
    off();
    listen();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('after a clean run the streak resets and a new failure is reported again', async () => {
    let failing = true;
    const boom = new Error('x');
    const query = vi.fn(() =>
      failing ? Promise.reject(boom) : Promise.resolve(mkStatus('granted')),
    );
    const { tracker, onError } = setup({ permissions: { query } }, { permissionNames: ['camera'] });
    const off = tracker.onAny(() => {});
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    off();
    failing = false;
    const off2 = tracker.onAny(() => {});
    await flush();
    off2();
    failing = true;
    tracker.onAny(() => {});
    await flush();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a synchronously throwing query is classified the same way', async () => {
    const boom = new Error('sync');
    const query = vi.fn(() => {
      throw boom;
    });
    const typeErr = vi.fn(() => {
      throw new TypeError('no');
    });
    const a = setup({ permissions: { query } }, { permissionNames: ['camera'] });
    a.listen();
    await flush();
    expect(a.onError).toHaveBeenCalledWith(boom);
    const b = setup({ permissions: { query: typeErr } }, { permissionNames: ['camera'] });
    b.listen();
    await flush();
    expect(b.onError).not.toHaveBeenCalled();
  });

  it('an error whose name getter throws is still reported (never escapes)', async () => {
    const hostile = {
      get name(): string {
        throw new Error('name');
      },
    };
    const query = vi.fn(() => Promise.reject(hostile));
    const { onError, listen } = setup({ permissions: { query } }, { permissionNames: ['camera'] });
    listen();
    await flush();
    expect(onError.mock.calls[0]?.[0]).toBe(hostile);
  });

  it('no Permissions API / hostile access: no states, launch is unaffected', async () => {
    const a = setup({});
    a.listen();
    await flush();
    expect(a.tracker.current().permissions).toBeUndefined();
    const b = setup({ permissions: {} });
    b.listen();
    expect(b.tracker.current().permissions).toBeUndefined();
    const c = setup({
      get permissions(): unknown {
        throw new Error('perm');
      },
    });
    c.listen();
    expect(c.onError).toHaveBeenCalledTimes(1);
    const d = setup({
      permissions: {
        get query(): unknown {
          throw new Error('q');
        },
      },
    });
    d.listen();
    expect(d.onError).toHaveBeenCalledTimes(1);
  });

  it('when every query fails the retained snapshot is kept and nothing is emitted', async () => {
    const perms = mkPermissions({ camera: 'granted' });
    const { tracker, seen, listen } = setup(
      { permissions: perms },
      { permissionNames: ['camera'] },
    );
    const off = listen();
    await flush();
    off();
    perms.query.mockImplementation(() => Promise.reject(new TypeError('nope')));
    seen.length = 0;
    listen();
    await flush();
    expect(tracker.current().permissions).toEqual({ camera: 'granted' });
    expect(seen).toEqual([]);
  });

  it('a status with a non-object value or without addEventListener is tolerated', async () => {
    const query = vi.fn((arg: { name: string }) =>
      Promise.resolve(arg.name === 'camera' ? 'raw-string' : { state: 'granted' }),
    );
    const { tracker, onError, listen } = setup(
      { permissions: { query } },
      { permissionNames: ['camera', 'microphone'] },
    );
    listen();
    await flush();
    expect(tracker.current().permissions).toEqual({ microphone: 'granted' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('a throwing status addEventListener / state getter / hostile add getter is reported, others unaffected', async () => {
    const badAdd = {
      state: 'granted',
      addEventListener: () => {
        throw new Error('add');
      },
    };
    const hostileGetter = {
      state: 'denied',
      get addEventListener(): unknown {
        throw new Error('addget');
      },
    };
    const hostileState = {
      get state(): string {
        throw new Error('state');
      },
    };
    const query = vi.fn(({ name }: { name: string }) =>
      Promise.resolve(
        { camera: badAdd, microphone: hostileGetter, geolocation: hostileState }[name],
      ),
    );
    const { tracker, onError, listen } = setup(
      { permissions: { query } },
      { permissionNames: ['camera', 'microphone', 'geolocation'] },
    );
    listen();
    await flush();
    expect(tracker.current().permissions).toEqual({ camera: 'granted', microphone: 'denied' });
    // add throw + getter throw + state throw (watch listener not attached for hostileState: state read at publish)
    expect(onError.mock.calls.map(([e]) => (e as Error).message)).toEqual([
      'add',
      'addget',
      'state',
    ]);
  });

  it('releases the status listeners on the last unsubscribe and ignores a late change', async () => {
    const perms = mkPermissions({ camera: 'granted' });
    const { tracker, seen, listen } = setup(
      { permissions: perms },
      { permissionNames: ['camera'] },
    );
    const off = listen();
    await flush();
    const cam = perms.statuses.get('camera');
    expect(cam?.count('change')).toBe(1);
    off();
    expect(cam?.count('change')).toBe(0);
    expect(tracker.current().permissions).toEqual({ camera: 'granted' }); // retained
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(1);
  });

  it('a late status change from an older attachment is ignored (generation guard)', async () => {
    const kept: Array<() => void> = [];
    const status = {
      state: 'granted',
      addEventListener: (_t: string, l: () => void) => void kept.push(l),
      removeEventListener: () => {}, // a host that keeps delivering to a removed listener
    };
    const { tracker, seen, listen } = setup(
      { permissions: { query: () => Promise.resolve(status) } },
      { permissionNames: ['camera'] },
    );
    const off = listen();
    await flush();
    off();
    seen.length = 0;
    status.state = 'denied';
    for (const l of kept) l();
    expect(seen).toEqual([]);
    expect(tracker.current().permissions).toEqual({ camera: 'granted' });
  });

  it('a query still in flight at the last unsubscribe is ignored when it settles', async () => {
    let resolve: (v: unknown) => void = () => {};
    const query = vi.fn(() => new Promise((r) => (resolve = r)));
    const { tracker, seen, listen } = setup(
      { permissions: { query } },
      { permissionNames: ['camera'] },
    );
    const off = listen();
    off();
    resolve(mkStatus('granted'));
    await flush();
    expect(tracker.current().permissions).toBeUndefined();
    expect(seen.filter(([n]) => n === 'permissions')).toEqual([]);
  });
});

describe('EnvironmentTracker: privateMode', () => {
  const quotaNav = (quota: unknown) => ({
    storage: { estimate: vi.fn(() => Promise.resolve({ quota })) },
  });

  it('is OFF by default: no storage call, no stage', async () => {
    const nav = quotaNav(1);
    const { tracker, seen, listen } = setup(nav);
    listen();
    await flush();
    expect(nav.storage.estimate).not.toHaveBeenCalled();
    expect(seen.filter(([n]) => n === 'privateMode')).toEqual([]);
    expect(tracker.current().privateMode).toBeUndefined();
  });

  it('an explicit detectPrivateMode:false is off too', async () => {
    const nav = quotaNav(1);
    const { tracker, listen } = setup(nav, { detectPrivateMode: false });
    listen();
    await flush();
    expect(nav.storage.estimate).not.toHaveBeenCalled();
    expect(tracker.current().privateMode).toBeUndefined();
  });

  it.each([
    [1024, 'yes', 'storage-quota'],
    [PRIVATE_QUOTA_BELOW_BYTES - 1, 'yes', 'storage-quota'],
    [PRIVATE_QUOTA_BELOW_BYTES, 'unknown', 'storage-quota'],
    [NORMAL_QUOTA_FROM_BYTES - 1, 'unknown', 'storage-quota'],
    [NORMAL_QUOTA_FROM_BYTES, 'no', 'storage-quota'],
  ])('quota %s -> %s', async (quota, answer, method) => {
    const { tracker, seen, listen } = setup(quotaNav(quota), { detectPrivateMode: true });
    listen();
    await flush();
    expect(seen.filter(([n]) => n === 'privateMode')).toEqual([
      ['privateMode', { private: answer, method }],
    ]);
    expect(tracker.current().privateMode).toEqual({ private: answer, method });
  });

  it.each([
    [undefined],
    [0],
    [-1],
    [Number.NaN],
    ['big'],
  ])('an unusable quota (%s) is unknown with no method', async (quota) => {
    const { tracker, listen } = setup(quotaNav(quota), { detectPrivateMode: true });
    listen();
    await flush();
    expect(tracker.current().privateMode).toEqual({ private: 'unknown' });
  });

  it('no Storage API -> unknown, immediately', () => {
    const { tracker, listen } = setup({}, { detectPrivateMode: true });
    listen();
    expect(tracker.current().privateMode).toEqual({ private: 'unknown' });
    const b = setup({ storage: {} }, { detectPrivateMode: true });
    b.listen();
    expect(b.tracker.current().privateMode).toEqual({ private: 'unknown' });
  });

  it('a rejected / throwing estimate is reported once per streak and yields unknown', async () => {
    const boom = new Error('estimate');
    const nav = { storage: { estimate: vi.fn(() => Promise.reject(boom)) } };
    const { tracker, onError } = setup(nav, { detectPrivateMode: true });
    const off = tracker.onAny(() => {});
    await flush();
    expect(tracker.current().privateMode).toEqual({ private: 'unknown' });
    off();
    tracker.onAny(() => {});
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    const sync = vi.fn(() => {
      throw new Error('sync');
    });
    const b = setup({ storage: { estimate: sync } }, { detectPrivateMode: true });
    b.listen();
    await flush();
    expect(b.onError).toHaveBeenCalledTimes(1);
    expect(b.tracker.current().privateMode).toEqual({ private: 'unknown' });
  });

  it('a clean run ends the failure streak', async () => {
    let fail = true;
    const nav = {
      storage: {
        estimate: vi.fn(() =>
          fail ? Promise.reject(new Error('x')) : Promise.resolve({ quota: 1 }),
        ),
      },
    };
    const { tracker, onError } = setup(nav, { detectPrivateMode: true });
    let off = tracker.onAny(() => {});
    await flush();
    off();
    fail = false;
    off = tracker.onAny(() => {});
    await flush();
    off();
    tracker.rebind({ detectPrivateMode: false }); // forget the definitive answer so it is probed again
    tracker.rebind({ detectPrivateMode: true });
    fail = true;
    tracker.onAny(() => {});
    await flush();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('hostile storage / estimate / quota getters are reported, never thrown', async () => {
    const a = setup(
      {
        get storage(): unknown {
          throw new Error('s');
        },
      },
      { detectPrivateMode: true },
    );
    a.listen();
    expect(a.onError).toHaveBeenCalledTimes(1);
    expect(a.tracker.current().privateMode).toEqual({ private: 'unknown' });
    const b = setup(
      {
        storage: {
          get estimate(): unknown {
            throw new Error('e');
          },
        },
      },
      { detectPrivateMode: true },
    );
    b.listen();
    expect(b.onError).toHaveBeenCalledTimes(1);
    const c = setup(
      {
        storage: {
          estimate: () =>
            Promise.resolve({
              get quota(): number {
                throw new Error('q');
              },
            }),
        },
      },
      { detectPrivateMode: true },
    );
    c.listen();
    await flush();
    expect(c.onError).toHaveBeenCalledTimes(1);
    expect(c.tracker.current().privateMode).toEqual({ private: 'unknown' });
  });

  it('a probe in flight at the last unsubscribe is ignored', async () => {
    let resolve: (v: unknown) => void = () => {};
    const nav = { storage: { estimate: () => new Promise((r) => (resolve = r)) } };
    const { tracker, seen, listen } = setup(nav, { detectPrivateMode: true });
    listen()();
    resolve({ quota: 1 });
    await flush();
    expect(seen.filter(([n]) => n === 'privateMode')).toEqual([]);
    expect(tracker.current().privateMode).toBeUndefined();
  });

  it('a stale rejection after the last unsubscribe is ignored (not reported)', async () => {
    let reject: (e: unknown) => void = () => {};
    const nav = { storage: { estimate: () => new Promise((_, r) => (reject = r)) } };
    const { tracker, onError, listen } = setup(nav, { detectPrivateMode: true });
    listen()();
    reject(new Error('late'));
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect(tracker.current().privateMode).toBeUndefined();
  });

  it('a restart does not repeat a definitive answer: no second probe and no duplicate event', async () => {
    const nav = quotaNav(1);
    const { tracker, seen, listen } = setup(nav, { detectPrivateMode: true });
    const off = listen();
    await flush();
    off();
    listen();
    await flush();
    expect(nav.storage.estimate).toHaveBeenCalledTimes(1);
    expect(seen.filter(([n]) => n === 'privateMode')).toEqual([
      ['privateMode', { private: 'yes', method: 'storage-quota' }],
    ]);
    expect(tracker.current().privateMode).toEqual({ private: 'yes', method: 'storage-quota' });
  });

  it('a restart does not repeat a definitive NO either', async () => {
    const nav = quotaNav(NORMAL_QUOTA_FROM_BYTES);
    const { seen, listen } = setup(nav, { detectPrivateMode: true });
    const off = listen();
    await flush();
    off();
    listen();
    await flush();
    expect(nav.storage.estimate).toHaveBeenCalledTimes(1);
    expect(seen.filter(([n]) => n === 'privateMode')).toHaveLength(1);
  });

  it('a restart re-probes an inconclusive answer, and emits only if it changed', async () => {
    let quota = 500 * 1024 * 1024; // between the thresholds: unknown
    const estimate = vi.fn(() => Promise.resolve({ quota }));
    const { seen, listen } = setup({ storage: { estimate } }, { detectPrivateMode: true });
    const off = listen();
    await flush();
    off();
    const off2 = listen();
    await flush();
    expect(estimate).toHaveBeenCalledTimes(2);
    expect(seen.filter(([n]) => n === 'privateMode')).toHaveLength(1); // same unknown: not repeated
    off2();
    quota = 1;
    listen();
    await flush();
    expect(seen.filter(([n]) => n === 'privateMode')).toEqual([
      ['privateMode', { private: 'unknown', method: 'storage-quota' }],
      ['privateMode', { private: 'yes', method: 'storage-quota' }],
    ]);
  });

  it('a rebind that moves seams while running does not repeat the answer', async () => {
    const nav = quotaNav(1);
    const { tracker, seen, listen } = setup(nav, { detectPrivateMode: true });
    listen();
    await flush();
    const win2 = mkTarget();
    wins.push(win2);
    tracker.rebind({ window: win2 });
    await flush();
    expect(win2.count('languagechange')).toBe(1); // it did re-attach
    expect(nav.storage.estimate).toHaveBeenCalledTimes(1);
    expect(seen.filter(([n]) => n === 'privateMode')).toHaveLength(1);
  });

  it('turning detection off then on again re-detects and re-emits', async () => {
    const nav = quotaNav(1);
    const { tracker, seen, listen } = setup(nav, { detectPrivateMode: true });
    listen();
    await flush();
    tracker.rebind({ detectPrivateMode: false });
    expect(tracker.current().privateMode).toBeUndefined();
    tracker.rebind({ detectPrivateMode: true });
    await flush();
    expect(nav.storage.estimate).toHaveBeenCalledTimes(2);
    expect(seen.filter(([n]) => n === 'privateMode')).toHaveLength(2);
  });

  it('a superseded in-flight probe does not double-emit when the tracker is re-listened', async () => {
    const { seen, listen } = setup(quotaNav(1), { detectPrivateMode: true });
    listen()();
    listen();
    await flush();
    expect(seen.filter(([n]) => n === 'privateMode')).toHaveLength(1);
  });
});

describe('EnvironmentTracker: lifecycle and retention', () => {
  it('releases every listener and timer on the last unsubscribe', () => {
    const { win, document, scheduler, listen } = setup();
    const off = listen();
    expect(win.count()).toBe(1);
    expect(document.count()).toBe(1);
    expect(scheduler.live.size).toBe(1);
    off();
    expect(win.count()).toBe(0);
    expect(document.count()).toBe(0);
    expect(scheduler.live.size).toBe(0);
  });

  it('retains readings across stop/start and compares new readings against them', () => {
    const { tracker, navigator, seen, listen } = setup();
    const off = listen();
    off();
    expect(tracker.current().language?.language).toBe('en-US');
    navigator.language = 'fr-FR';
    navigator.languages = ['fr-FR'];
    listen();
    const changes = seen.filter(([n]) => n === 'language');
    expect(changes).toHaveLength(1);
    expect((changes[0]?.[1] as { previous: unknown }).previous).toEqual({
      language: 'en-US',
      languages: ['en-US', 'en'],
    });
  });

  it('reset() forgets readings and releases everything', () => {
    const { tracker, win, scheduler, listen } = setup();
    listen();
    tracker.reset();
    expect(tracker.current()).toEqual({});
    expect(win.count()).toBe(0);
    expect(scheduler.live.size).toBe(0);
  });

  it('a throwing onError never escapes; a missing one is fine', () => {
    const t = new EnvironmentTracker(
      {
        navigator: {
          get language(): string {
            throw new Error('x');
          },
        },
        scheduler: mkScheduler(),
      },
      () => {
        throw new Error('reporter');
      },
    );
    expect(() => t.on('language', () => {})).not.toThrow();
    const u = new EnvironmentTracker({
      navigator: {
        get language(): string {
          throw new Error('x');
        },
      },
      scheduler: mkScheduler(),
    });
    expect(() => u.on('language', () => {})).not.toThrow();
  });

  it('a throwing subscriber is isolated through the guarded reporter', () => {
    const { tracker, navigator, win, onError } = setup();
    tracker.on('language', () => {
      throw new Error('listener');
    });
    navigator.language = 'de';
    win.fire('languagechange');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('refused listener registration / hostile addEventListener are reported and do not abort activation', () => {
    const win = {
      addEventListener: () => {
        throw new Error('add');
      },
    };
    const doc = {
      get addEventListener(): unknown {
        throw new Error('doc add');
      },
    };
    const onError = vi.fn();
    const t = new EnvironmentTracker(
      {
        window: win,
        document: doc as never,
        navigator: { language: 'en' },
        scheduler: mkScheduler(),
      },
      onError,
    );
    t.on('language', () => {});
    expect(onError).toHaveBeenCalledTimes(2);
    expect(t.current().language?.language).toBe('en');
    const nonFn = new EnvironmentTracker({
      window: { addEventListener: 1 },
      scheduler: mkScheduler(),
    });
    expect(() => nonFn.on('language', () => {})).not.toThrow();
  });

  it('a throwing removeEventListener / clearInterval is tolerated (clearInterval reported)', () => {
    const scheduler = mkScheduler();
    scheduler.clearInterval = () => {
      throw new Error('clear');
    };
    const win = {
      addEventListener: () => {},
      removeEventListener: () => {
        throw new Error('remove');
      },
    };
    const onError = vi.fn();
    const t = new EnvironmentTracker({ window: win, scheduler }, onError);
    const off = t.on('language', () => {});
    expect(() => off()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a throwing scheduler.setInterval is reported and the immediate readings still work', () => {
    const scheduler = mkScheduler();
    scheduler.setInterval = () => {
      throw new Error('arm');
    };
    const onError = vi.fn();
    const t = new EnvironmentTracker({ navigator: { language: 'en' }, scheduler }, onError);
    t.on('language', () => {});
    expect(onError).toHaveBeenCalledTimes(1);
    expect(t.current().language?.language).toBe('en');
  });

  it('a hostile status.removeEventListener is tolerated', async () => {
    const status = {
      state: 'granted',
      addEventListener: () => {},
      removeEventListener: () => {
        throw new Error('rm');
      },
    };
    const { listen, onError } = setup(
      { permissions: { query: () => Promise.resolve(status) } },
      { permissionNames: ['camera'] },
    );
    const off = listen();
    await flush();
    expect(() => off()).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a hostile visibilityState is reported and treated as "not hidden"', () => {
    const document = {
      get visibilityState(): string {
        throw new Error('vis');
      },
      addEventListener: () => {},
    };
    const scheduler = mkScheduler();
    const onError = vi.fn();
    const zone = { offset: 0 };
    const t = new EnvironmentTracker(
      { document, scheduler, timeZoneId: () => 'UTC', utcOffsetMinutes: () => zone.offset },
      onError,
    );
    const seen: unknown[] = [];
    t.on('timezone', (e) => seen.push(e));
    zone.offset = 60;
    scheduler.tick();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });
});

describe('EnvironmentTracker: rebind', () => {
  it('merges seams: a partial env never drops what the tracker has; defined ones replace', () => {
    const { tracker, navigator, scheduler, listen } = setup();
    tracker.rebind({ detectPrivateMode: false });
    listen();
    expect(tracker.current().language?.language).toBe('en-US');
    expect(scheduler.live.size).toBe(1);
    tracker.rebind({ timeZoneId: () => 'UTC', utcOffsetMinutes: () => 0, permissionNames: [] });
    navigator.language = 'it';
    tracker.rebind({}, undefined);
    expect(tracker.current().language?.language).toBe('en-US'); // nothing re-read by a seam-less rebind
  });

  it('a running tracker moves its listeners: detach with OLD seams, then attach to the new ones', () => {
    const { tracker, win, document, scheduler, listen } = setup();
    listen();
    const win2 = mkTarget({ isSecureContext: true });
    const doc2 = mkDocument();
    const sched2 = mkScheduler();
    wins.push(win2);
    tracker.rebind({ window: win2, document: doc2, scheduler: sched2 });
    expect(win.count()).toBe(0);
    expect(document.count()).toBe(0);
    expect(scheduler.live.size).toBe(0);
    expect(win2.count('languagechange')).toBe(1);
    expect(doc2.count()).toBe(1);
    expect(sched2.live.size).toBe(1);
  });

  it('an idle tracker only swaps seams (nothing is attached)', () => {
    const { tracker, win } = setup();
    const win2 = mkTarget();
    tracker.rebind({ window: win2, navigator: { language: 'ja' } });
    expect(win2.count()).toBe(0);
    expect(win.count()).toBe(0);
    tracker.onAny(() => {});
    expect(win2.count('languagechange')).toBe(1);
    expect(tracker.current().language?.language).toBe('ja');
    wins.push(win2);
  });

  it('an unchanged-object rebind does not re-attach', () => {
    const { tracker, win, document, scheduler, listen } = setup();
    listen();
    tracker.rebind({ window: win, document, scheduler, intervalMs: 777 });
    expect(win.count()).toBe(1);
    expect(scheduler.periods).toEqual([777]);
  });

  it('a changed navigator or interval also re-attaches', () => {
    const { tracker, scheduler, listen } = setup();
    listen();
    tracker.rebind({ navigator: { language: 'es' } });
    expect(scheduler.periods).toEqual([777, 777]);
    tracker.rebind({ intervalMs: 5 });
    expect(scheduler.periods).toEqual([777, 777, 5]);
  });

  it('the latest onError wins (undefined keeps it)', () => {
    const { tracker, onError } = setup({
      get language(): string {
        throw new Error('x');
      },
    });
    const later = vi.fn();
    tracker.rebind({}, later);
    tracker.rebind({}, undefined);
    tracker.onAny(() => {});
    expect(later).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('detectPrivateMode turned ON while running probes right away; OFF drops the result and in-flight probes', async () => {
    const nav = { storage: { estimate: vi.fn(() => Promise.resolve({ quota: 1 })) } };
    const { tracker, seen, listen } = setup(nav);
    listen();
    expect(nav.storage.estimate).not.toHaveBeenCalled();
    tracker.rebind({ detectPrivateMode: true });
    await flush();
    expect(nav.storage.estimate).toHaveBeenCalledTimes(1);
    expect(tracker.current().privateMode).toEqual({ private: 'yes', method: 'storage-quota' });
    // restarting an already-on tracker does not probe twice via rebind
    tracker.rebind({ detectPrivateMode: true });
    expect(nav.storage.estimate).toHaveBeenCalledTimes(1);
    tracker.rebind({ detectPrivateMode: false });
    expect(tracker.current().privateMode).toBeUndefined();
    seen.length = 0;
    // in-flight probe dropped when switched off
    let resolve: (v: unknown) => void = () => {};
    const slow = { storage: { estimate: () => new Promise((r) => (resolve = r)) } };
    const s = setup(slow, { detectPrivateMode: true });
    s.listen();
    s.tracker.rebind({ detectPrivateMode: false });
    resolve({ quota: 1 });
    await flush();
    expect(s.tracker.current().privateMode).toBeUndefined();
    expect(s.seen.filter(([n]) => n === 'privateMode')).toEqual([]);
  });

  it('turning detectPrivateMode ON while idle only takes effect at activation', async () => {
    const nav = { storage: { estimate: vi.fn(() => Promise.resolve({ quota: 1 })) } };
    const { tracker, listen } = setup(nav);
    tracker.rebind({ detectPrivateMode: true });
    expect(nav.storage.estimate).not.toHaveBeenCalled();
    listen();
    await flush();
    expect(nav.storage.estimate).toHaveBeenCalledTimes(1);
  });

  it('an in-flight permission query from before a move is ignored', async () => {
    let resolve: (v: unknown) => void = () => {};
    const query = vi.fn(() => new Promise((r) => (resolve = r)));
    const { tracker, listen } = setup({ permissions: { query } }, { permissionNames: ['camera'] });
    listen();
    tracker.rebind({
      navigator: { permissions: { query: () => Promise.resolve(mkStatus('denied')) } },
    });
    const stale = resolve;
    await flush();
    expect(tracker.current().permissions).toEqual({ camera: 'denied' });
    stale(mkStatus('granted'));
    await flush();
    expect(tracker.current().permissions).toEqual({ camera: 'denied' });
  });
});

describe('environmentTrackerFor', () => {
  it('is a singleton per window and rebinds on every later call', async () => {
    const win = mkTarget();
    wins.push(win);
    const probeError = new Error('quota');
    const probe = vi.fn(() => Promise.reject(probeError));
    const first = vi.fn();
    const a = environmentTrackerFor(
      { window: win, navigator: { language: 'en', storage: { estimate: probe } } },
      first,
    );
    const onError = vi.fn();
    const b = environmentTrackerFor({ window: win, detectPrivateMode: true }, onError);
    expect(b).toBe(a);
    // the shared tracker answers to the SECOND call's seams: private mode on (probing the first call's navigator,
    // which a partial env keeps) and the second call's reporter, not the first
    b.onAny(() => {});
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(probeError);
    expect(first).not.toHaveBeenCalled();
    const other = mkTarget();
    wins.push(other);
    expect(environmentTrackerFor({ window: other })).not.toBe(a);
    resetEnvironmentTracker({ window: other });
  });

  it('keys on the window, else the navigator, else the env object; hostile getters are reported', () => {
    const nav = { language: 'en' };
    expect(environmentTrackerFor({ navigator: nav })).toBe(
      environmentTrackerFor({ navigator: nav }),
    );
    const env = {};
    expect(environmentTrackerFor(env)).toBe(environmentTrackerFor(env));
    expect(environmentTrackerFor({})).not.toBe(environmentTrackerFor({}));
    const onError = vi.fn();
    const hostile = {
      get window(): object {
        throw new Error('win');
      },
      get navigator(): object {
        throw new Error('nav');
      },
    };
    const tracker = environmentTrackerFor(hostile, onError);
    expect(tracker).toBeInstanceOf(EnvironmentTracker);
    // each hostile getter is read (and reported) exactly once per call
    expect(onError.mock.calls.map(([e]) => (e as Error).message)).toEqual(['win', 'nav']);
  });

  it('reads env.window and env.navigator once per call (seams and key share the reading)', () => {
    const win = mkTarget();
    wins.push(win);
    const nav = { language: 'en' };
    let windowReads = 0;
    let navigatorReads = 0;
    const env: EnvironmentEnv = {
      get window() {
        windowReads += 1;
        return win;
      },
      get navigator() {
        navigatorReads += 1;
        return nav;
      },
    };
    const tracker = environmentTrackerFor(env);
    expect([windowReads, navigatorReads]).toEqual([1, 1]);
    expect(environmentTrackerFor(env)).toBe(tracker);
    expect([windowReads, navigatorReads]).toEqual([2, 2]);
    expect(environmentTrackerFor({ window: win })).toBe(tracker); // keyed on the window it read
  });

  it('resetEnvironmentTracker drops the singleton and releases its listeners', () => {
    const win = mkTarget();
    wins.push(win);
    const first = environmentTrackerFor({ window: win, navigator: { language: 'en' } });
    first.on('language', () => {});
    expect(win.count()).toBe(1);
    resetEnvironmentTracker({ window: win });
    expect(win.count()).toBe(0);
    expect(environmentTrackerFor({ window: win })).not.toBe(first);
  });
});

describe('EnvironmentTracker: guarded callbacks and comparison', () => {
  const poisonEmit = (tracker: EnvironmentTracker, error: Error) =>
    vi
      .spyOn(tracker as unknown as { emit(...a: unknown[]): void }, 'emit')
      .mockImplementation(() => {
        throw error;
      });

  it('a throwing timer callback is reported, never thrown, and the next tick still works', () => {
    const { tracker, scheduler, zone, onError, listen } = setup();
    listen();
    const boom = new Error('emit');
    const emit = poisonEmit(tracker, boom);
    zone.offset = 180;
    expect(() => scheduler.tick()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
    emit.mockRestore();
    zone.offset = 240;
    expect(() => scheduler.tick()).not.toThrow();
    expect(tracker.current().timeZone).toEqual({ timeZone: 'Europe/Kyiv', utcOffsetMinutes: 240 });
  });

  it('a throwing PermissionStatus change listener is reported, never thrown into the DOM dispatch', async () => {
    const perms = mkPermissions({ camera: 'granted' });
    const { tracker, onError, listen } = setup(
      { permissions: perms },
      { permissionNames: ['camera'] },
    );
    listen();
    await flush();
    const boom = new Error('emit');
    poisonEmit(tracker, boom);
    const cam = perms.statuses.get('camera');
    if (cam === undefined) throw new Error('no status');
    cam.state = 'denied';
    expect(() => cam.fire('change')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('compares readings regardless of key order (a re-ordered but equal permissions snapshot is not a change)', async () => {
    const perms = mkPermissions({ camera: 'granted', microphone: 'denied' });
    const { tracker, seen, listen } = setup(
      { permissions: perms },
      { permissionNames: ['camera', 'microphone'] },
    );
    const off = listen();
    await flush();
    expect(Object.keys(tracker.current().permissions ?? {})).toEqual(['camera', 'microphone']);
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(1);
    off();
    tracker.rebind({ permissionNames: ['microphone', 'camera'] });
    listen();
    await flush();
    expect(Object.keys(tracker.current().permissions ?? {})).toEqual(['microphone', 'camera']);
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(1); // same values: no re-emission
    const cam = perms.statuses.get('camera');
    if (cam === undefined) throw new Error('no status');
    cam.state = 'denied';
    cam.fire('change');
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(2); // a real change still emits
  });

  it('does not re-emit an unchanged hints / permissions snapshot to a restarted tracker (retained comparison)', async () => {
    const perms = mkPermissions({ camera: 'granted' });
    const { tracker, seen, listen } = setup(
      { permissions: perms, cookieEnabled: true },
      { permissionNames: ['camera'] },
    );
    const off = listen();
    await flush();
    expect(seen.filter(([n]) => n === 'hints' || n === 'permissions')).toHaveLength(2);
    off();
    seen.length = 0;
    listen();
    await flush();
    expect(seen.filter(([n]) => n === 'hints' || n === 'permissions')).toEqual([]);
    expect(tracker.current().permissions).toEqual({ camera: 'granted' });
  });
});

describe('EnvironmentTracker: failure streaks (reported once, then quiet until a clean run)', () => {
  const boomOn = (flag: { on: boolean }, message: string) => {
    if (flag.on) throw new Error(message);
  };
  const messages = (onError: ReturnType<typeof vi.fn>) =>
    onError.mock.calls.map(([e]) => (e as Error).message);

  it('language: a persistently failing read is reported once; recovery then a new failure reports again', () => {
    const flag = { on: true };
    const nav = {
      get language(): string {
        boomOn(flag, 'lang');
        return 'en';
      },
    };
    const { scheduler, onError, listen } = setup(nav);
    listen(); // activation read fails
    scheduler.tick();
    scheduler.tick();
    expect(messages(onError)).toEqual(['lang']);
    flag.on = false;
    scheduler.tick();
    expect(messages(onError)).toEqual(['lang']);
    flag.on = true;
    scheduler.tick();
    expect(messages(onError)).toEqual(['lang', 'lang']);
  });

  it('time zone: once per streak', () => {
    const flag = { on: true };
    const { scheduler, onError, listen } = setup(undefined, {
      timeZoneId: () => {
        boomOn(flag, 'tz');
        return 'UTC';
      },
    });
    listen();
    scheduler.tick();
    scheduler.tick();
    expect(messages(onError)).toEqual(['tz']);
    flag.on = false;
    scheduler.tick();
    flag.on = true;
    scheduler.tick();
    expect(messages(onError)).toEqual(['tz', 'tz']);
  });

  it('hints: once per streak', () => {
    const flag = { on: true };
    const nav = {
      language: 'en',
      get cookieEnabled(): boolean {
        boomOn(flag, 'hint');
        return true;
      },
    };
    const { scheduler, onError, listen } = setup(nav);
    listen();
    scheduler.tick();
    scheduler.tick();
    expect(messages(onError)).toEqual(['hint']);
    flag.on = false;
    scheduler.tick();
    flag.on = true;
    scheduler.tick();
    expect(messages(onError)).toEqual(['hint', 'hint']);
  });

  it('visibility: once per streak (timer ticks and visibilitychange share it)', () => {
    const flag = { on: true };
    const document = mkTarget();
    Object.defineProperty(document, 'visibilityState', {
      get(): string {
        boomOn(flag, 'vis');
        return 'visible';
      },
    });
    const { scheduler, onError, listen } = setup(undefined, { document });
    listen();
    scheduler.tick();
    document.fire('visibilitychange');
    scheduler.tick();
    expect(messages(onError)).toEqual(['vis']);
    flag.on = false;
    scheduler.tick();
    flag.on = true;
    scheduler.tick();
    expect(messages(onError)).toEqual(['vis', 'vis']);
  });

  it('a streak reports every error of its first run (two failing reads of one stage)', () => {
    const nav = {
      get language(): string {
        throw new Error('a');
      },
      get languages(): string[] {
        throw new Error('b');
      },
    };
    const { scheduler, onError, listen } = setup(nav);
    listen();
    scheduler.tick();
    expect(messages(onError)).toEqual(['a', 'b']);
  });

  it('reset() ends every streak, so the same failure is reported again afterwards', async () => {
    const nav = {
      get language(): string {
        throw new Error('lang');
      },
      storage: { estimate: () => Promise.reject(new Error('quota')) },
      permissions: { query: () => Promise.reject(new Error('perm')) },
    };
    const { tracker, onError, listen } = setup(nav, {
      detectPrivateMode: true,
      permissionNames: ['camera'],
    });
    const off = listen();
    await flush();
    expect(messages(onError).sort()).toEqual(['lang', 'perm', 'quota']);
    off();
    tracker.reset();
    onError.mockClear();
    listen();
    await flush();
    expect(messages(onError).sort()).toEqual(['lang', 'perm', 'quota']);
  });
});

describe('EnvironmentTracker: rebind seams', () => {
  it.each([
    ['window', () => ({ window: mkTarget({ isSecureContext: true }) })],
    ['navigator', () => ({ navigator: { language: 'fr' } })],
    ['document', () => ({ document: mkDocument() })],
    ['scheduler', () => ({ scheduler: mkScheduler() })],
    ['intervalMs', () => ({ intervalMs: 999 })],
  ])('changing ONLY %s on a running tracker re-attaches', (key, change) => {
    const { tracker, win, document, scheduler, listen } = setup();
    listen();
    const swap = change() as Partial<EnvironmentEnv>;
    const next = (swap.window ?? win) as ReturnType<typeof mkTarget>;
    if (swap.window) wins.push(swap.window);
    tracker.rebind(swap);
    // detached from the OLD seams and attached to the (new or kept) ones, exactly once each
    const nextDoc = (swap.document ?? document) as ReturnType<typeof mkTarget>;
    const nextSched = (swap.scheduler ?? scheduler) as ReturnType<typeof mkScheduler>;
    expect(next.count('languagechange')).toBe(1);
    expect(nextDoc.count('visibilitychange')).toBe(1);
    expect(nextSched.live.size).toBe(1);
    if (key === 'window') expect(win.count()).toBe(0);
    if (key === 'document') expect(document.count()).toBe(0);
    if (key === 'scheduler') expect(scheduler.live.size).toBe(0);
    if (key === 'intervalMs') expect(scheduler.periods).toEqual([777, 999]);
    if (key === 'navigator') expect(tracker.current().language?.language).toBe('fr'); // re-read from the new navigator
  });

  it('timeZoneId / utcOffsetMinutes replace ours on rebind and survive a seam-less rebind', () => {
    const { tracker, listen } = setup();
    tracker.rebind({ timeZoneId: () => 'Asia/Tokyo', utcOffsetMinutes: () => 540 });
    tracker.rebind({});
    listen();
    expect(tracker.current().timeZone).toEqual({ timeZone: 'Asia/Tokyo', utcOffsetMinutes: 540 });
  });

  it('a hostile getter on the rebind env is reported through the latest reporter, not thrown', () => {
    const { tracker, onError } = setup();
    const later = vi.fn();
    const env = {
      get window(): object {
        throw new Error('hostile');
      },
    };
    expect(() => tracker.rebind(env as EnvironmentEnv, later)).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('EnvironmentTracker: emitted payloads are copies', () => {
  it('a subscriber mutating an emitted stage object cannot change the retained readings', async () => {
    const perms = mkPermissions({ camera: 'granted' });
    const { tracker, win, navigator, scheduler, zone, document, listen } = setup(
      { language: 'en', languages: ['en'], cookieEnabled: true, permissions: perms },
      { permissionNames: ['camera'], detectPrivateMode: true },
    );
    const got: Record<string, any> = {};
    tracker.onAny((name, payload) => {
      got[name] = payload;
      const p = payload as Record<string, any>;
      p.mutated = true;
      p.languages?.push('xx');
    });
    void listen;
    await flush();
    navigator.language = 'de';
    navigator.languages = ['de'];
    win.fire('languagechange');
    zone.offset = 180;
    scheduler.tick();
    expect(Object.keys(got).sort()).toEqual([
      'hints',
      'language',
      'permissions',
      'privateMode',
      'timezone',
    ]);
    const cur = tracker.current();
    expect(cur.language).toEqual({ language: 'de', languages: ['de'] });
    expect(cur.timeZone).toEqual({ timeZone: 'Europe/Kyiv', utcOffsetMinutes: 180 });
    expect(cur.hints).not.toHaveProperty('mutated');
    expect(cur.permissions).toEqual({ camera: 'granted' });
    expect(cur.privateMode).not.toHaveProperty('mutated');
    void document;
  });
});

describe('EnvironmentTracker: a failing field keeps its retained value (no fake changes)', () => {
  const evs = (seen: Array<[string, unknown]>, name: string) => seen.filter(([n]) => n === name);

  it('language: one field throwing then recovering emits nothing; a real change afterwards still does', () => {
    const flag = { langFails: false, languagesFail: false };
    const state = { language: 'en', languages: ['en', 'de'] };
    const nav = {
      get language(): string {
        if (flag.langFails) throw new Error('language');
        return state.language;
      },
      get languages(): string[] {
        if (flag.languagesFail) throw new Error('languages');
        return state.languages;
      },
    };
    const { tracker, scheduler, win, seen, listen } = setup(nav);
    listen();
    flag.langFails = true;
    win.fire('languagechange');
    expect(tracker.current().language).toEqual({ language: 'en', languages: ['en', 'de'] });
    flag.langFails = false;
    flag.languagesFail = true;
    win.fire('languagechange');
    expect(tracker.current().language).toEqual({ language: 'en', languages: ['en', 'de'] });
    flag.languagesFail = false;
    scheduler.tick();
    expect(evs(seen, 'language')).toEqual([]);
    // a failing field next to a REAL change of the other: only the real change shows
    flag.langFails = true;
    state.languages = ['de'];
    win.fire('languagechange');
    expect(evs(seen, 'language')).toEqual([
      [
        'language',
        {
          language: 'en',
          languages: ['de'],
          previous: { language: 'en', languages: ['en', 'de'] },
        },
      ],
    ]);
  });

  it('a subscriber mutating previous.languages cannot corrupt the retained reading (kept array shared)', () => {
    const state = { language: 'en', languagesFail: false };
    const nav = {
      get language(): string {
        return state.language;
      },
      get languages(): string[] {
        if (state.languagesFail) throw new Error('languages');
        return ['en', 'de'];
      },
    };
    const { tracker, win, listen } = setup(nav);
    const got: Array<{ previous: { languages?: string[] } }> = [];
    tracker.on('language', (e) => {
      got.push(e as never);
      e.previous.languages?.push('xx');
    });
    listen();
    state.languagesFail = true; // the failing field keeps the retained array
    state.language = 'fr';
    win.fire('languagechange');
    expect(got).toHaveLength(1);
    expect(tracker.current().language).toEqual({ language: 'fr', languages: ['en', 'de'] });
  });

  it('time zone: id or offset throwing once then recovering emits nothing', () => {
    const fail = { id: false, offset: false };
    const { tracker, scheduler, seen, listen } = setup(undefined, {
      timeZoneId: () => {
        if (fail.id) throw new Error('id');
        return 'Europe/Kyiv';
      },
      utcOffsetMinutes: () => {
        if (fail.offset) throw new Error('offset');
        return 120;
      },
    });
    listen();
    fail.id = true;
    scheduler.tick();
    expect(tracker.current().timeZone).toEqual({ timeZone: 'Europe/Kyiv', utcOffsetMinutes: 120 });
    fail.id = false;
    fail.offset = true;
    scheduler.tick();
    expect(tracker.current().timeZone).toEqual({ timeZone: 'Europe/Kyiv', utcOffsetMinutes: 120 });
    fail.offset = false;
    scheduler.tick();
    expect(evs(seen, 'timezone')).toEqual([]);
  });

  it('hints: a throwing hint keeps its retained value (each hint, incl. doNotTrack and serviceWorker)', () => {
    const fail = { on: false };
    const guard = <T>(v: T): T => {
      if (fail.on) throw new Error('hint');
      return v;
    };
    const nav = {
      language: 'en',
      get cookieEnabled() {
        return guard(true);
      },
      get webdriver() {
        return guard(false);
      },
      get globalPrivacyControl() {
        return guard(true);
      },
      get doNotTrack() {
        return guard('1');
      },
      get serviceWorker() {
        return guard({ controller: {} });
      },
    };
    const win = mkTarget();
    Object.defineProperty(win, 'isSecureContext', { get: () => guard(true) });
    Object.defineProperty(win, 'crossOriginIsolated', { get: () => guard(false) });
    wins.push(win);
    const { tracker, scheduler, seen, listen } = setup(nav, { window: win });
    listen();
    const full = tracker.current().hints;
    expect(full).toEqual({
      cookiesEnabled: true,
      secureContext: true,
      crossOriginIsolated: false,
      serviceWorkerControlled: true,
      automation: false,
      doNotTrack: true,
      globalPrivacyControl: true,
    });
    fail.on = true;
    scheduler.tick();
    expect(tracker.current().hints).toEqual(full);
    fail.on = false;
    scheduler.tick();
    expect(evs(seen, 'hints')).toHaveLength(1); // only the first snapshot
  });

  it('a throwing PermissionStatus.state getter is reported once per streak, not every run', async () => {
    const flag = { on: true };
    const status = mkTarget();
    Object.defineProperty(status, 'state', {
      get() {
        if (flag.on) throw new Error('state');
        return 'granted';
      },
    });
    const { onError, tracker, listen } = setup(
      { permissions: { query: () => Promise.resolve(status) } },
      { permissionNames: ['camera'] },
    );
    listen();
    await flush();
    status.fire('change');
    status.fire('change');
    expect(onError.mock.calls.map(([e]) => (e as Error).message)).toEqual(['state']);
    flag.on = false;
    status.fire('change');
    expect(tracker.current().permissions).toEqual({ camera: 'granted' });
    flag.on = true;
    status.fire('change');
    expect(onError).toHaveBeenCalledTimes(2);
  });

  const throwingStatus = (flag: { on: boolean }, state: string, message: string) => {
    const status = mkTarget();
    Object.defineProperty(status, 'state', {
      get() {
        if (flag.on) throw new Error(message);
        return state;
      },
    });
    return status;
  };

  it('a throwing state read keeps the retained state: no fake {} change, no emission, then recovery is silent', async () => {
    const flag = { on: false };
    const status = throwingStatus(flag, 'granted', 'state');
    const { tracker, seen, listen } = setup(
      { permissions: { query: () => Promise.resolve(status) } },
      { permissionNames: ['camera'] },
    );
    listen();
    await flush();
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(1);
    flag.on = true;
    status.fire('change');
    expect(tracker.current().permissions).toEqual({ camera: 'granted' });
    flag.on = false;
    status.fire('change');
    expect(tracker.current().permissions).toEqual({ camera: 'granted' });
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(1);
  });

  it('a name whose re-query FAILS keeps its retained state; a TypeError (unsupported) omits it', async () => {
    const mode = { mic: 'ok' as 'ok' | 'fail' | 'type' };
    const query = vi.fn(({ name }: { name: string }) => {
      if (name === 'microphone' && mode.mic === 'fail') return Promise.reject(new Error('mic'));
      if (name === 'microphone' && mode.mic === 'type') return Promise.reject(new TypeError('x'));
      return Promise.resolve(mkStatus(name === 'camera' ? 'granted' : 'denied'));
    });
    const { tracker, seen, onError, listen } = setup(
      { permissions: { query } },
      { permissionNames: ['camera', 'microphone'] },
    );
    let off = listen();
    await flush();
    const full = { camera: 'granted', microphone: 'denied' };
    expect(tracker.current().permissions).toEqual(full);
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(1);
    off();
    mode.mic = 'fail';
    off = listen();
    await flush();
    expect(onError.mock.calls.map(([e]) => (e as Error).message)).toEqual(['mic']);
    expect(tracker.current().permissions).toEqual(full); // retained, not dropped
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(1); // and no fake change
    off();
    mode.mic = 'type';
    listen();
    await flush();
    expect(tracker.current().permissions).toEqual({ camera: 'granted' }); // unsupported: omitted
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(2);
  });

  it('a state read that throws during a re-query keeps the retained state of that name', async () => {
    const flag = { on: false };
    const cam = throwingStatus(flag, 'granted', 'cam');
    const mic = mkStatus('denied');
    const query = ({ name }: { name: string }) => Promise.resolve(name === 'camera' ? cam : mic);
    const { tracker, seen, listen } = setup(
      { permissions: { query } },
      { permissionNames: ['camera', 'microphone'] },
    );
    const off = listen();
    await flush();
    off();
    flag.on = true;
    listen();
    await flush();
    expect(tracker.current().permissions).toEqual({ camera: 'granted', microphone: 'denied' });
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(1);
  });

  it('state-read streaks are per permission name', async () => {
    const camFlag = { on: true };
    const micFlag = { on: true };
    const cam = throwingStatus(camFlag, 'granted', 'cam');
    const mic = throwingStatus(micFlag, 'denied', 'mic');
    const query = ({ name }: { name: string }) => Promise.resolve(name === 'camera' ? cam : mic);
    const { onError, listen } = setup(
      { permissions: { query } },
      { permissionNames: ['camera', 'microphone'] },
    );
    listen();
    await flush();
    // both names fail on the first run: BOTH are reported
    expect(onError.mock.calls.map(([e]) => (e as Error).message)).toEqual(['cam', 'mic']);
    cam.fire('change');
    mic.fire('change');
    expect(onError).toHaveBeenCalledTimes(2); // silent for both while the streaks last
    // camera keeps failing while microphone is clean: camera stays quiet, microphone's clean run does not reset it
    micFlag.on = false;
    mic.fire('change');
    cam.fire('change');
    mic.fire('change');
    cam.fire('change');
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe('EnvironmentTracker: reset with subscribers, defaults and listener pins', () => {
  it('reset() drops subscribers and a NEW subscriber re-activates the tracker', () => {
    const { tracker, win, scheduler, document, seen, listen } = setup();
    listen();
    expect(scheduler.live.size).toBe(1);
    tracker.reset();
    expect(scheduler.live.size).toBe(0);
    expect(win.count()).toBe(0);
    expect(document.count()).toBe(0);
    expect(tracker.current()).toEqual({});
    seen.length = 0;
    const off = listen();
    expect(scheduler.live.size).toBe(1);
    expect(win.count('languagechange')).toBe(1);
    expect(document.count('visibilitychange')).toBe(1);
    expect(tracker.current().language?.language).toBe('en-US');
    off();
    expect(scheduler.live.size).toBe(0);
  });

  it('the default UTC offset is positive EAST of UTC (getTimezoneOffset is positive WEST)', () => {
    const spy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-120); // UTC+2
    try {
      const t = new EnvironmentTracker({});
      const off = t.on('timezone', () => {});
      expect(t.current().timeZone?.utcOffsetMinutes).toBe(120);
      off();
      spy.mockReturnValue(300); // UTC-5
      const u = new EnvironmentTracker({});
      const offU = u.on('timezone', () => {});
      expect(u.current().timeZone?.utcOffsetMinutes).toBe(-300);
      offU();
    } finally {
      spy.mockRestore();
    }
  });

  it('release still tries to remove a listener whose addEventListener threw', () => {
    const removed: string[] = [];
    const win = {
      addEventListener: () => {
        throw new Error('add');
      },
      removeEventListener: (type: string) => void removed.push(type),
      isSecureContext: true,
    };
    const { tracker, onError } = setup(undefined, { window: win as never });
    const off = tracker.onAny(() => {});
    expect(onError.mock.calls.map(([e]) => (e as Error).message)).toEqual(['add']);
    off();
    expect(removed).toEqual(['languagechange']);
  });

  it.each([
    ['hidden', 'hidden'],
    ['prerender', 'prerender'],
    ['unreadable', undefined],
  ])('visibilitychange to a %s page does not re-read', (_label, state) => {
    const document = mkTarget();
    let current: string | undefined = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      get() {
        if (current === undefined) throw new Error('vis');
        return current;
      },
    });
    const { tracker, navigator, listen } = setup(undefined, { document });
    listen();
    navigator.language = 'fr';
    current = state;
    document.fire('visibilitychange');
    expect(tracker.current().language?.language).toBe('en-US');
    current = 'visible';
    document.fire('visibilitychange');
    expect(tracker.current().language?.language).toBe('fr');
  });
});

describe('EnvironmentTracker: unusable answers and private-mode read streaks', () => {
  it('an answered but UNUSABLE state replaces a retained one: the stale entry is cleared and the change emitted', async () => {
    const status = mkStatus('granted');
    const { tracker, seen, listen } = setup(
      { permissions: { query: () => Promise.resolve(status) } },
      { permissionNames: ['camera'] },
    );
    const off = listen();
    await flush();
    off();
    status.state = 'weird'; // answers, but not a usable state
    listen();
    await flush();
    expect(tracker.current().permissions).toEqual({});
    expect(seen.filter(([n]) => n === 'permissions')).toEqual([
      ['permissions', { camera: 'granted' }],
      ['permissions', {}],
    ]);
  });

  it('a throwing state with nothing retained yields no snapshot and no emission (a failed read is not an answer)', async () => {
    const status = mkTarget();
    Object.defineProperty(status, 'state', {
      get(): string {
        throw new Error('state');
      },
    });
    const { tracker, seen, listen } = setup(
      { permissions: { query: () => Promise.resolve(status) } },
      { permissionNames: ['camera'] },
    );
    listen();
    await flush();
    expect(tracker.current().permissions).toBeUndefined();
    expect(seen.filter(([n]) => n === 'permissions')).toEqual([]);
  });

  it('a FAILED query (or throwing state) still retains the snapshot and emits nothing', async () => {
    let mode: 'ok' | 'reject' = 'ok';
    const query = vi.fn(() =>
      mode === 'ok' ? Promise.resolve(mkStatus('granted')) : Promise.reject(new Error('q')),
    );
    const { tracker, seen, listen } = setup(
      { permissions: { query } },
      { permissionNames: ['camera'] },
    );
    const off = listen();
    await flush();
    off();
    mode = 'reject';
    listen();
    await flush();
    expect(tracker.current().permissions).toEqual({ camera: 'granted' });
    expect(seen.filter(([n]) => n === 'permissions')).toHaveLength(1);
  });

  it('private mode: storage / estimate / quota getter failures are reported once per streak, recovery starts a new one', async () => {
    const fail = { storage: true, quota: false };
    const nav = {
      get storage(): unknown {
        if (fail.storage) throw new Error('storage');
        return {
          estimate: () =>
            Promise.resolve({
              get quota(): number {
                if (fail.quota) throw new Error('quota');
                return 500 * 1024 * 1024; // inconclusive: probed again on every restart
              },
            }),
        };
      },
    };
    const { tracker, onError, listen } = setup(nav as never, { detectPrivateMode: true });
    const messages = () => onError.mock.calls.map(([e]) => (e as Error).message);
    let off = listen();
    await flush();
    off();
    off = listen();
    await flush();
    off();
    expect(messages()).toEqual(['storage']); // the second failing probe is quiet
    fail.storage = false;
    off = listen(); // clean probe ends the streak
    await flush();
    off();
    fail.quota = true;
    off = listen();
    await flush();
    off();
    off = listen();
    await flush();
    off();
    expect(messages()).toEqual(['storage', 'quota']);
    fail.storage = true;
    listen();
    await flush();
    expect(messages()).toEqual(['storage', 'quota', 'storage']); // a new streak
    expect(tracker.current().privateMode).toEqual({ private: 'unknown' });
  });
});

describe('EnvironmentTracker: hints and permissions are read only when asked for', () => {
  const nav = () => ({
    language: 'en',
    cookieEnabled: true,
    doNotTrack: '1',
    permissions: mkPermissions({ camera: 'granted' }),
  });

  it('by default neither the hints are read nor a permission is queried, for any subscriber', async () => {
    const n = nav();
    const { tracker, seen, listen, win, document } = setup(n, {
      observeHints: undefined,
      queryPermissions: undefined,
    });
    listen();
    await flush();
    expect(n.permissions.query).not.toHaveBeenCalled();
    expect(tracker.current().hints).toBeUndefined();
    expect(tracker.current().permissions).toBeUndefined();
    expect(seen.filter(([k]) => k === 'hints' || k === 'permissions')).toEqual([]);
    expect(tracker.current().language?.language).toBe('en'); // the other stages still run
    document.fire('visibilitychange');
    expect(tracker.current().hints).toBeUndefined();
    expect(win.count('languagechange')).toBe(1);
  });

  it('queryPermissions alone queries permissions and does not read hints; observeHints alone the reverse', async () => {
    const a = nav();
    const onlyPerms = setup(a, { observeHints: false });
    onlyPerms.listen();
    await flush();
    expect(a.permissions.query).toHaveBeenCalled();
    expect(onlyPerms.tracker.current().permissions).toEqual({ camera: 'granted' });
    expect(onlyPerms.tracker.current().hints).toBeUndefined();
    const b = nav();
    const onlyHints = setup(b, { queryPermissions: false });
    onlyHints.listen();
    await flush();
    expect(b.permissions.query).not.toHaveBeenCalled();
    expect(onlyHints.tracker.current().permissions).toBeUndefined();
    expect(onlyHints.tracker.current().hints?.cookiesEnabled).toBe(true);
  });

  it('turning them on while running reads/queries at once; off drops the readings and the status listeners', async () => {
    const n = nav();
    const { tracker, listen, seen } = setup(n, { observeHints: false, queryPermissions: false });
    listen();
    await flush();
    expect(n.permissions.query).not.toHaveBeenCalled();
    tracker.rebind({ observeHints: true, queryPermissions: true });
    await flush();
    expect(n.permissions.query).toHaveBeenCalled();
    expect(tracker.current().permissions).toEqual({ camera: 'granted' });
    expect(tracker.current().hints?.doNotTrack).toBe(true);
    const status = n.permissions.statuses.get('camera');
    expect(status?.count('change')).toBe(1);
    tracker.rebind({ observeHints: false, queryPermissions: false });
    expect(tracker.current().permissions).toBeUndefined();
    expect(tracker.current().hints).toBeUndefined();
    expect(status?.count('change')).toBe(0);
    seen.length = 0;
    tracker.rebind({ observeHints: true });
    expect(seen.filter(([k]) => k === 'hints')).toHaveLength(1); // re-read after being off
  });

  it('each gate re-attaches on its own: queryPermissions off drops the statuses while hints stay, and back', async () => {
    const n = nav();
    const { tracker, listen } = setup(n);
    listen();
    await flush();
    const status = n.permissions.statuses.get('camera');
    expect(status?.count('change')).toBe(1);
    tracker.rebind({ queryPermissions: false });
    expect(status?.count('change')).toBe(0);
    expect(tracker.current().permissions).toBeUndefined();
    expect(tracker.current().hints?.cookiesEnabled).toBe(true);
    const calls = n.permissions.query.mock.calls.length;
    tracker.rebind({ queryPermissions: true });
    await flush();
    expect(n.permissions.query.mock.calls.length).toBeGreaterThan(calls);
    expect(tracker.current().permissions).toEqual({ camera: 'granted' });
    tracker.rebind({ observeHints: false });
    expect(tracker.current().hints).toBeUndefined();
    expect(tracker.current().permissions).toEqual({ camera: 'granted' });
    tracker.rebind({ observeHints: true });
    expect(tracker.current().hints?.cookiesEnabled).toBe(true);
  });

  it('an idle tracker only applies the change at activation', async () => {
    const n = nav();
    const { tracker, listen } = setup(n, { observeHints: false, queryPermissions: false });
    tracker.rebind({ queryPermissions: true });
    expect(n.permissions.query).not.toHaveBeenCalled();
    listen();
    await flush();
    expect(n.permissions.query).toHaveBeenCalled();
  });
});
