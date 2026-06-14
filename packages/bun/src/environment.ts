import process from 'node:process';
import { realSystemProbe, type SystemProbe } from '@bugsee/node';

// The Bun SystemProbe. Bun runs on a node-compatible API surface, so the OS/CPU/memory/locale reads reuse
// @bugsee/node's realSystemProbe verbatim — only the runtime IDENTITY differs: platform.type 'bun' and
// platform.version from `process.versions.bun` (Bun's own version, NOT the node-compat version it also
// reports). The version source is injectable so both the present/absent branches are testable under Node;
// it falls back to the node-compat version when `bun` is absent (e.g. accidentally run under Node), so the
// envelope always carries a version string.

interface RuntimeVersions {
  /** Bun's own version (process.versions.bun); absent under Node. */
  bun?: string;
  /** The node-compat version (always present), the fallback. */
  node: string;
}

export function createBunSystemProbe(versions: RuntimeVersions = process.versions): SystemProbe {
  return {
    ...realSystemProbe,
    platformType: () => 'bun',
    runtimeVersion: () => versions.bun ?? versions.node,
  };
}

/** The default Bun probe over the live `process.versions`. */
export const bunSystemProbe: SystemProbe = createBunSystemProbe();
