// Runtime detection. Used only for *content* decisions (e.g. "should I open IndexedDB?"),
// never to pick a transport/storage impl — that is chosen at build time (design §6).
// Reads globals through a typed view of globalThis so no DOM/Node lib is pulled in.

interface RuntimeGlobals {
  Bun?: unknown;
  Deno?: unknown;
  process?: { versions?: { node?: unknown; electron?: unknown }; type?: unknown };
  window?: { document?: unknown };
  importScripts?: unknown;
  ServiceWorkerGlobalScope?: unknown;
  navigator?: { userAgent?: unknown };
  EdgeRuntime?: unknown;
}

const g = globalThis as unknown as RuntimeGlobals;

export const isBun = (): boolean => typeof g.Bun !== 'undefined';

export const isDeno = (): boolean => typeof g.Deno !== 'undefined';

export const isNode = (): boolean =>
  typeof g.process?.versions?.node === 'string' && !isBun() && !isDeno();

export const isBrowser = (): boolean => typeof g.window?.document !== 'undefined';

export const isWebWorker = (): boolean => typeof g.importScripts === 'function';

export const isServiceWorker = (): boolean => typeof g.ServiceWorkerGlobalScope !== 'undefined';

export const isCloudflareWorker = (): boolean => g.navigator?.userAgent === 'Cloudflare-Workers';

export const isVercelEdge = (): boolean => typeof g.EdgeRuntime === 'string';

export const isElectronRenderer = (): boolean => g.process?.type === 'renderer';

export const isElectronMain = (): boolean =>
  typeof g.process?.versions?.electron === 'string' && g.process?.type === 'browser';
