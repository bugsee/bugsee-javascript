// THE wire-name registry for the system streams (`traces.system` / `events.system`): every trace and event name a
// JavaScript producer writes is declared here ONCE, and producers reference these constants, never a string literal.
// The names are the JavaScript platform spec's (bugsee/specs `sdk/reporting/platforms/javascript.md`); the vendored
// snapshot of its tables (`spec/javascript-system-traces.snapshot.json`, refreshed by `pnpm spec:refresh`) is compared
// against this module by the drift test in `@bugsee/instrumentation-tests` (spec-drift.test.ts), which also fails when
// a producer file spells a registered name as a literal. Adding a name = add it here (with its spec metadata), then use it.
//
// What is NOT here, on purpose: names the spec marks pending and the SDK does not emit yet (`route`, `view`,
// `thermal_state`, `cpu_speed_limit` — listed with reasons in the drift test, so they cannot be forgotten), retired names
// (`screen_size`, `electron_displays`, `gc_*`, `process_uptime_s`, `ram_system_available`), and the user streams
// (`traces.user` / `events.user` belong to the application, never to the SDK).

/** The JSON value a trace carries. */
export type TraceValueType = 'int' | 'float' | 'string' | 'object' | 'list';

/** The unit a numeric trace is in (`null`: not a measured quantity, e.g. an enum, a state or a structured value). */
export type TraceUnit = 'bytes' | 'mb' | 'us' | 'ms' | 's' | 'percent' | 'fps' | null;

/** What the spec fixes about a trace besides its name. */
export interface TraceSpec {
  readonly valueType: TraceValueType;
  readonly unit: TraceUnit;
  /** `true`: a step curve re-recorded every `refreshMs`; `false`: written when sampled and never refreshed. */
  readonly held: boolean;
}

/**
 * System trace wire names (`traces.system`). Key = the wire name upper-cased. A string enum, not a const object: when a
 * bundle inlines every use (the WebView IIFE has a size budget) the enum object disappears, where an object of constants
 * stays whole, every name of every runtime included.
 */
export enum TraceName {
  APP_METRICS = 'app_metrics',
  APP_STATE = 'app_state',
  BATTERY = 'battery',
  BATTERY_CHARGING_TIME_S = 'battery_charging_time_s',
  BATTERY_DISCHARGING_TIME_S = 'battery_discharging_time_s',
  CAPTURE = 'capture',
  CHARGING = 'charging',
  CONNECTION = 'connection',
  CPU_USAGE_PROCESS = 'cpu_usage_process',
  CPU_USAGE_SYSTEM = 'cpu_usage_system',
  CPU_USAGE_USER = 'cpu_usage_user',
  DISK_MEM_FREE = 'disk_mem_free',
  DISK_MEM_TOTAL = 'disk_mem_total',
  DISPLAYS = 'displays',
  EVENT_LOOP_LAG_MAX_MS = 'event_loop_lag_max_ms',
  EVENT_LOOP_LAG_MS = 'event_loop_lag_ms',
  EVENT_LOOP_LAG_P99_MS = 'event_loop_lag_p99_ms',
  EVENT_LOOP_UTILIZATION = 'event_loop_utilization',
  FPS = 'fps',
  MAIN_THREAD_IDLE_MS = 'main_thread_idle_ms',
  MAIN_THREAD_LAG_MS = 'main_thread_lag_ms',
  ORIENTATION = 'orientation',
  PROCESS_MEMORY_ARRAY_BUFFERS = 'process_memory_array_buffers',
  PROCESS_MEMORY_EXTERNAL = 'process_memory_external',
  PROCESS_MEMORY_HEAP_TOTAL = 'process_memory_heap_total',
  PROCESS_MEMORY_HEAP_USED = 'process_memory_heap_used',
  PROCESS_MEMORY_LIMIT = 'process_memory_limit',
  PROCESS_MEMORY_RSS = 'process_memory_rss',
  RAM_JS_HEAP_FREE = 'ram_js_heap_free',
  RAM_JS_HEAP_TOTAL = 'ram_js_heap_total',
  RAM_JS_HEAP_USED = 'ram_js_heap_used',
  RAM_SYSTEM_ADVERTISED = 'ram_system_advertised',
  RAM_SYSTEM_FREE = 'ram_system_free',
  RAM_SYSTEM_TOTAL = 'ram_system_total',
  STORAGE_ESTIMATE = 'storage_estimate',
  URL = 'url',
  USER_IDLE_STATE = 'user_idle_state',
  V8_HEAP_AVAILABLE = 'v8_heap_available',
  V8_HEAP_MALLOCED = 'v8_heap_malloced',
  V8_HEAP_PEAK_MALLOCED = 'v8_heap_peak_malloced',
  V8_HEAP_SIZE_LIMIT = 'v8_heap_size_limit',
}

/** The spec metadata of every registered trace (compared against the vendored spec snapshot). */
export const TRACE_SPEC: { readonly [N in TraceName]: TraceSpec } = {
  [TraceName.APP_METRICS]: { valueType: 'object', unit: null, held: false },
  [TraceName.APP_STATE]: { valueType: 'string', unit: null, held: true },
  [TraceName.BATTERY]: { valueType: 'int', unit: 'percent', held: true },
  [TraceName.BATTERY_CHARGING_TIME_S]: { valueType: 'int', unit: 's', held: false },
  [TraceName.BATTERY_DISCHARGING_TIME_S]: { valueType: 'int', unit: 's', held: false },
  [TraceName.CAPTURE]: { valueType: 'object', unit: null, held: true },
  [TraceName.CHARGING]: { valueType: 'object', unit: null, held: true },
  [TraceName.CONNECTION]: { valueType: 'object', unit: null, held: true },
  [TraceName.CPU_USAGE_PROCESS]: { valueType: 'float', unit: 'percent', held: false },
  [TraceName.CPU_USAGE_SYSTEM]: { valueType: 'int', unit: 'us', held: false },
  [TraceName.CPU_USAGE_USER]: { valueType: 'int', unit: 'us', held: false },
  [TraceName.DISK_MEM_FREE]: { valueType: 'int', unit: 'mb', held: false },
  [TraceName.DISK_MEM_TOTAL]: { valueType: 'int', unit: 'mb', held: false },
  [TraceName.DISPLAYS]: { valueType: 'list', unit: null, held: true },
  [TraceName.EVENT_LOOP_LAG_MAX_MS]: { valueType: 'float', unit: 'ms', held: false },
  [TraceName.EVENT_LOOP_LAG_MS]: { valueType: 'float', unit: 'ms', held: false },
  [TraceName.EVENT_LOOP_LAG_P99_MS]: { valueType: 'float', unit: 'ms', held: false },
  [TraceName.EVENT_LOOP_UTILIZATION]: { valueType: 'float', unit: 'percent', held: false },
  [TraceName.FPS]: { valueType: 'float', unit: 'fps', held: false },
  [TraceName.MAIN_THREAD_IDLE_MS]: { valueType: 'float', unit: 'ms', held: false },
  [TraceName.MAIN_THREAD_LAG_MS]: { valueType: 'float', unit: 'ms', held: false },
  [TraceName.ORIENTATION]: { valueType: 'int', unit: null, held: true },
  [TraceName.PROCESS_MEMORY_ARRAY_BUFFERS]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.PROCESS_MEMORY_EXTERNAL]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.PROCESS_MEMORY_HEAP_TOTAL]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.PROCESS_MEMORY_HEAP_USED]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.PROCESS_MEMORY_LIMIT]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.PROCESS_MEMORY_RSS]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.RAM_JS_HEAP_FREE]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.RAM_JS_HEAP_TOTAL]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.RAM_JS_HEAP_USED]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.RAM_SYSTEM_ADVERTISED]: { valueType: 'int', unit: 'bytes', held: true },
  [TraceName.RAM_SYSTEM_FREE]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.RAM_SYSTEM_TOTAL]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.STORAGE_ESTIMATE]: { valueType: 'object', unit: null, held: true },
  [TraceName.URL]: { valueType: 'string', unit: null, held: true },
  [TraceName.USER_IDLE_STATE]: { valueType: 'string', unit: null, held: true },
  [TraceName.V8_HEAP_AVAILABLE]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.V8_HEAP_MALLOCED]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.V8_HEAP_PEAK_MALLOCED]: { valueType: 'int', unit: 'bytes', held: false },
  [TraceName.V8_HEAP_SIZE_LIMIT]: { valueType: 'int', unit: 'bytes', held: false },
};

/** System event wire names (`events.system`). Mobile-shared names keep their mobile spelling; the rest are snake_case. */
export enum EventName {
  DARK_MODE_CHANGED = 'DarkModeChanged',
  ORIENTATION_CHANGED = 'OrientationChanged',
  APPLICATION_DID_BECOME_ACTIVE = 'UIApplicationDidBecomeActiveNotification',
  APPLICATION_DID_ENTER_BACKGROUND = 'UIApplicationDidEnterBackgroundNotification',
  CHILD_PROCESS_GONE = 'child_process_gone',
  DISPLAY_ADDED = 'display_added',
  DISPLAY_METRICS_CHANGED = 'display_metrics_changed',
  DISPLAY_MODE_CHANGED = 'display_mode_changed',
  DISPLAY_REMOVED = 'display_removed',
  FREEZE = 'freeze',
  GC = 'gc',
  LANGUAGE_CHANGED = 'language_changed',
  OFFLINE = 'offline',
  ONLINE = 'online',
  POWER_AC = 'power_ac',
  POWER_BATTERY = 'power_battery',
  POWER_LOCK = 'power_lock',
  POWER_RESUME = 'power_resume',
  POWER_SUSPEND = 'power_suspend',
  POWER_UNLOCK = 'power_unlock',
  PRIVATE_MODE_DETECTED = 'private_mode_detected',
  PROCESS_BEFORE_EXIT = 'process_before_exit',
  PROCESS_EXITING = 'process_exiting',
  PROCESS_SIGNAL = 'process_signal',
  PROCESS_STARTED = 'process_started',
  PROCESS_WARNING = 'process_warning',
  RENDERER_RESPONSIVE = 'renderer_responsive',
  RENDERER_UNRESPONSIVE = 'renderer_unresponsive',
  RESUME = 'resume',
  TIMEZONE_CHANGED = 'timezone_changed',
  WINDOW_BLUR = 'window_blur',
  WINDOW_FOCUS = 'window_focus',
  WINDOW_HIDE = 'window_hide',
  WINDOW_SHOW = 'window_show',
}

/** The param keys of every registered event (camelCase; a trailing `?` marks a key that may be absent). */
export const EVENT_PARAMS: { readonly [N in EventName]: readonly string[] } = {
  [EventName.DARK_MODE_CHANGED]: ['dark'],
  [EventName.ORIENTATION_CHANGED]: ['angle', 'current', 'prev', 'type'],
  [EventName.APPLICATION_DID_BECOME_ACTIVE]: [],
  [EventName.APPLICATION_DID_ENTER_BACKGROUND]: [],
  [EventName.CHILD_PROCESS_GONE]: ['exitCode?', 'name?', 'reason', 'serviceName?', 'type'],
  [EventName.DISPLAY_ADDED]: [
    'height',
    'id',
    'maxFps?',
    'nativeId',
    'naturalHeight?',
    'naturalWidth?',
    'rotation?',
    'scale?',
    'type?',
    'width',
  ],
  [EventName.DISPLAY_METRICS_CHANGED]: ['changed'],
  [EventName.DISPLAY_MODE_CHANGED]: ['mode', 'previousMode'],
  [EventName.DISPLAY_REMOVED]: [
    'height',
    'id',
    'maxFps?',
    'nativeId',
    'naturalHeight?',
    'naturalWidth?',
    'rotation?',
    'scale?',
    'type?',
    'width',
  ],
  [EventName.FREEZE]: [],
  [EventName.GC]: ['count', 'maxPauseMs', 'pauseMs'],
  [EventName.LANGUAGE_CHANGED]: ['language?', 'languages?', 'previousLanguage?'],
  [EventName.OFFLINE]: [],
  [EventName.ONLINE]: [],
  [EventName.POWER_AC]: [],
  [EventName.POWER_BATTERY]: [],
  [EventName.POWER_LOCK]: [],
  [EventName.POWER_RESUME]: [],
  [EventName.POWER_SUSPEND]: [],
  [EventName.POWER_UNLOCK]: [],
  [EventName.PRIVATE_MODE_DETECTED]: ['method?'],
  [EventName.PROCESS_BEFORE_EXIT]: ['code'],
  [EventName.PROCESS_EXITING]: ['code', 'persisted'],
  [EventName.PROCESS_SIGNAL]: ['signal'],
  [EventName.PROCESS_STARTED]: [],
  [EventName.PROCESS_WARNING]: ['message', 'name?'],
  [EventName.RENDERER_RESPONSIVE]: ['webContentsId?'],
  [EventName.RENDERER_UNRESPONSIVE]: ['webContentsId?'],
  [EventName.RESUME]: [],
  [EventName.TIMEZONE_CHANGED]: [
    'previousTimezone?',
    'previousUtcOffsetMinutes?',
    'timezone?',
    'utcOffsetMinutes?',
  ],
  [EventName.WINDOW_BLUR]: ['windowId?'],
  [EventName.WINDOW_FOCUS]: ['windowId?'],
  [EventName.WINDOW_HIDE]: ['windowId?'],
  [EventName.WINDOW_SHOW]: ['windowId?'],
};
