import process from 'node:process';
import { realSystemProbe, type SystemProbe } from '@bugsee/node';

// The Deno SystemProbe. Deno (2+) runs on a node-compatible API surface, so the OS/CPU/memory/locale reads
// reuse @bugsee/node's realSystemProbe verbatim — only the runtime IDENTITY differs: platform.type 'deno'
// and platform.version from Deno's own version (`Deno.version.deno`), with a node-compat fallback. The
// version is injectable so both branches are testable under Node (where the `Deno` global is absent).

/** Read the live `Deno.version.deno`, or undefined when not running under Deno. */
const liveDenoVersion = (): string | undefined => {
  try {
    return (globalThis as unknown as { Deno: { version: { deno: string } } }).Deno.version.deno;
  } catch {
    return undefined; // not running under Deno (the global / version is absent)
  }
};

export function createDenoSystemProbe(
  denoVersion: string | undefined = liveDenoVersion(),
  nodeVersion: string = process.versions.node,
): SystemProbe {
  return {
    ...realSystemProbe,
    platformType: () => 'deno',
    runtimeVersion: () => denoVersion ?? nodeVersion,
  };
}

/** The default Deno probe over the live `Deno` global. */
export const denoSystemProbe: SystemProbe = createDenoSystemProbe();
