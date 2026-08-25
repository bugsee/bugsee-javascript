import type { TraceSample } from '@bugsee/capture';
import { connectionTypeToWire, orientationToWire } from './system-trace-values';

// Browser system-traces sampler for @bugsee/capture's systemTracesProvider (the node memory/cpu sampler
// analog). Each interval it reads the available browser context APIs and emits a traces.system value per
// source (Android traces.system parity, web-native; every source degrades gracefully where its API is
// absent — Safari has no navigator.connection, performance.memory + battery are Chromium-only):
//   performance.memory        → ram_js_heap_{total,free,used}                   (Android `ram_jvm_heap`)
//   navigator.connection      → connection { type, ... }                        (Android `connection`)
//   screen.orientation        → orientation (Android Orientation int)           (Android `orientation`)
// The last two carry ANDROID's vocabulary, not the browser's — see ./system-trace-values.ts for why
// and how. `traces.system` is a cross-platform stream and the viewer renders it from fixed tables, so
// a browser-shaped value is a value nothing can render.
//   navigator.getBattery()    → battery (0-100) + charging                      (Android `power_status`)
// getBattery() is async, so the BatteryManager is fetched once on construction and cached; its
// `level`/`charging` update live, so the sampler reads the cached manager each interval (omitted until it
// resolves / where unsupported).

interface BrowserMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}
interface NetworkInformation {
  /** The transport ('wifi' | 'cellular' | …). Chromium-on-Android in practice; absent elsewhere. */
  type?: string;
  /** A SPEED bucket ('4g', '3g'), not a transport — reported as detail, never as the identity. */
  effectiveType?: string;
  /** Estimated downlink in MEGAbits/s. Android reports kbps, so this is scaled on the way out. */
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}
interface BatteryManager {
  level: number;
  charging: boolean;
}
interface ScreenOrientationLike {
  type: string;
  angle: number;
}

/** Injected browser context surfaces (each optional; an absent one is not sampled). */
export interface BrowserTracesEnv {
  performance?: { memory?: BrowserMemory };
  navigator?: {
    connection?: NetworkInformation;
    getBattery?: () => Promise<BatteryManager>;
    /** navigator.onLine — the one connectivity fact every browser reports. */
    onLine?: boolean;
  };
  screen?: { orientation?: ScreenOrientationLike };
}

const realEnv = (): BrowserTracesEnv => {
  const global = globalThis as {
    performance?: { memory?: BrowserMemory };
    navigator?: {
      connection?: NetworkInformation;
      getBattery?: () => Promise<BatteryManager>;
      onLine?: boolean;
    };
    screen?: { orientation?: ScreenOrientationLike };
  };
  return { performance: global.performance, navigator: global.navigator, screen: global.screen };
};

/** Build a system-traces sampler over the browser context APIs (default the real globals). */
export function createBrowserSystemTracesSampler(
  env: BrowserTracesEnv = realEnv(),
): () => TraceSample[] {
  // Fetch the BatteryManager once; cache it. Its level/charging update live, so the sampler reads the
  // cached manager each interval. Omitted until it resolves (or where getBattery is unsupported/denied).
  let battery: BatteryManager | undefined;
  env.navigator?.getBattery?.().then(
    (manager) => {
      battery = manager;
    },
    () => {}, // unsupported / permission denied → no battery traces
  );

  return () => {
    const samples: TraceSample[] = [];
    const memory = env.performance?.memory;
    if (memory !== undefined) {
      // `total` is the heap CEILING and `free` is total - used, which is Android's `ram_jvm_heap`
      // contract exactly (BugseeTrackerProcess: heapSize is the max, heapFree = heapSize - used). So
      // the limit is the total here — NOT totalJSHeapSize, which is only what the engine has committed
      // so far and would make `free` shrink as the heap grew.
      const limit = memory.jsHeapSizeLimit;
      const used = memory.usedJSHeapSize;
      samples.push(
        { name: 'ram_js_heap_total', value: limit },
        { name: 'ram_js_heap_free', value: limit - used },
        { name: 'ram_js_heap_used', value: used },
      );
    }
    // Sampled whenever there is a `navigator` at all, NOT only when NetworkInformation exists: Safari
    // and Firefox have no `navigator.connection`, and this trace used to be omitted there entirely.
    // `onLine` alone is worth a row — it is the fact a reader most wants and every browser reports it.
    const navigator = env.navigator;
    if (navigator !== undefined) {
      const connection = navigator.connection;
      samples.push({
        name: 'connection',
        value: {
          type: connectionTypeToWire(connection, navigator.onLine !== false),
          // Everything below is DETAIL (the viewer renders `item.data`), so it is omitted rather than
          // sent as undefined — a key holding undefined does not survive JSON.stringify anyway, and
          // an explicitly absent key is what the other tiers send.
          ...(connection?.effectiveType !== undefined
            ? { effective_type: connection.effectiveType }
            : {}),
          // Android reports bandwidth in kbps (`link_downstream_kbps`); `downlink` is Mbps.
          ...(connection?.downlink !== undefined
            ? { link_downstream_kbps: Math.round(connection.downlink * 1000) }
            : {}),
          ...(connection?.rtt !== undefined ? { rtt: connection.rtt } : {}),
          ...(connection?.saveData !== undefined ? { save_data: connection.saveData } : {}),
        },
      });
    }
    const orientation = env.screen?.orientation;
    if (orientation !== undefined) {
      samples.push({
        name: 'orientation',
        value: orientationToWire(orientation.type, orientation.angle),
      });
    }
    if (battery !== undefined) {
      samples.push(
        { name: 'battery', value: Math.round(battery.level * 100) }, // 0-1 → 0-100 (Android parity)
        { name: 'charging', value: battery.charging },
      );
    }
    return samples;
  };
}
