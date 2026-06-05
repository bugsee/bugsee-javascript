import type { TraceSample } from '@bugsee/capture';

// Browser system-traces sampler for @bugsee/capture's systemTracesProvider (the node memory/cpu sampler
// analog). Each interval it reads the available browser context APIs and emits a traces.system value per
// source (Android traces.system parity, web-native; every source degrades gracefully where its API is
// absent — Safari has no navigator.connection, performance.memory + battery are Chromium-only):
//   performance.memory        → browser_memory_{used,total,limit}_heap (Chromium only)
//   navigator.connection      → connection { type, downlink, rtt, save_data }   (Android `connection`)
//   screen.orientation        → orientation { type, angle }                     (Android `orientation`)
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
  effectiveType?: string;
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
  navigator?: { connection?: NetworkInformation; getBattery?: () => Promise<BatteryManager> };
  screen?: { orientation?: ScreenOrientationLike };
}

const realEnv = (): BrowserTracesEnv => {
  const global = globalThis as {
    performance?: { memory?: BrowserMemory };
    navigator?: { connection?: NetworkInformation; getBattery?: () => Promise<BatteryManager> };
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
      samples.push(
        { name: 'browser_memory_used_heap', value: memory.usedJSHeapSize },
        { name: 'browser_memory_total_heap', value: memory.totalJSHeapSize },
        { name: 'browser_memory_heap_limit', value: memory.jsHeapSizeLimit },
      );
    }
    const connection = env.navigator?.connection;
    if (connection !== undefined) {
      samples.push({
        name: 'connection',
        value: {
          type: connection.effectiveType,
          downlink: connection.downlink,
          rtt: connection.rtt,
          save_data: connection.saveData,
        },
      });
    }
    const orientation = env.screen?.orientation;
    if (orientation !== undefined) {
      samples.push({
        name: 'orientation',
        value: { type: orientation.type, angle: orientation.angle },
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
