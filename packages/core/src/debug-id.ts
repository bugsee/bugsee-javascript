// SM7 — runtime debug-ID attach. A build-time injected stub registers, per bundle,
// `globalThis._bugseeDebugIds[<that script's Error().stack>] = <debugId>`. Each stack's TOP frame is the
// bundle's own file, so we can build a `file → debugId` map and stamp `debugId` onto captured stack frames
// (so a report carries the join key that ties each frame to its uploaded source-map). Runtime-portable:
// reaches the global only via an injectable seam, never imports node/DOM.
import { parseV8Stack, type StackFrame } from './stack';

/** Shape of the injected registration global. */
interface DebugIdGlobal {
  _bugseeDebugIds?: unknown;
}

/** Safely read the `_bugseeDebugIds` registration map (stackString → debugId) from a global object. */
export function readDebugIds(globalObject: unknown): Record<string, string> {
  if (typeof globalObject !== 'object' || globalObject === null) {
    return {};
  }
  const ids = (globalObject as DebugIdGlobal)._bugseeDebugIds;
  return typeof ids === 'object' && ids !== null ? (ids as Record<string, string>) : {};
}

/** An injected predicate must never take a report down: a throw is a rejection. */
function accepts(
  accept: (file: string, debugId: string) => boolean,
  file: string,
  debugId: string,
): boolean {
  try {
    return accept(file, debugId);
  } catch {
    return false;
  }
}

/**
 * Build a `file → debugId` map from the registration map: parse each registered stack and key the debug-ID
 * by its TOP frame's file (the bundle that registered it).
 */
export function buildDebugIdMap(
  debugIds: Record<string, string>,
  parseStack: (stack: string) => StackFrame[],
  accept?: (file: string, debugId: string) => boolean,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [stack, debugId] of Object.entries(debugIds)) {
    const file = parseStack(stack)[0]?.file;
    if (file !== undefined && (accept === undefined || accepts(accept, file, debugId))) {
      map.set(file, debugId);
    }
  }
  return map;
}

/** Stamp `debugId` onto every frame whose file has one in the map (in place). */
export function attachDebugIds(frames: StackFrame[], debugIdMap: Map<string, string>): void {
  for (const frame of frames) {
    if (frame.file !== undefined) {
      const debugId = debugIdMap.get(frame.file);
      if (debugId !== undefined) {
        frame.debugId = debugId;
      }
    }
  }
}

/**
 * Does the runtime already rewrite `Error.stack` through source maps (`node --enable-source-maps`,
 * `process.setSourceMapsEnabled(true)`)? Reads `process.sourceMapsEnabled` ONLY through a `globalThis` cast, so this
 * stays runtime-portable: browsers/workers/edge have no such `process`, Bun does not define the property.
 */
export function runtimeMapsStacks(
  proc: unknown = (globalThis as unknown as { process?: unknown }).process,
): boolean {
  if (typeof proc !== 'object' || proc === null) {
    return false;
  }
  return (proc as { sourceMapsEnabled?: unknown }).sourceMapsEnabled === true;
}

/** Does this registration (its top-frame file + debug-id) really belong to the stamped bundle? */
export type RegistrationVerifier = (file: string, debugId: string) => boolean;

let installedVerifier: RegistrationVerifier | undefined;

/**
 * Install the process-wide registration verifier (a platform with a filesystem: `@bugsee/node`). Module state,
 * like `setStackAppRoot`: core is runtime-portable and cannot read files itself. `undefined` removes it.
 */
export function setDebugIdRegistrationVerifier(verifier: RegistrationVerifier | undefined): void {
  installedVerifier = verifier;
}

/**
 * Resolve + stamp debug-IDs onto `frames` in place, reading the registration global (default `globalThis`)
 * and parsing registered stacks with `parseStack` (default {@link parseV8Stack}). A no-op when no build
 * injected debug-IDs.
 *
 * When the runtime maps stacks itself ({@link runtimeMapsStacks}; override via `options.runtimeMapsStacks`) AND a
 * verifier is available (`options.verifyRegistration`, else the installed one), each registration is checked: one
 * whose top-frame file is NOT the stamped bundle was source-mapped to an ORIGINAL file, and joining on it would
 * stamp the bundle's id onto already-mapped frames (the backend remaps them again: a wrong line, #185). The check is
 * per registration, never a global switch: the flag only says the process CAN map, not that this bundle's map is on
 * disk (the plugin deletes maps after upload by default) or was enabled before the bundle loaded; in those cases
 * the registration is intact and the plain join is correct. Without a verifier every registration is kept.
 */
export function applyDebugIds(
  frames: StackFrame[],
  options: {
    globalObject?: unknown;
    parseStack?: (stack: string) => StackFrame[];
    runtimeMapsStacks?: boolean;
    verifyRegistration?: RegistrationVerifier;
  } = {},
): void {
  const globalObject = options.globalObject ?? (globalThis as unknown);
  const debugIds = readDebugIds(globalObject);
  if (Object.keys(debugIds).length === 0) {
    return;
  }
  const parseStack = options.parseStack ?? parseV8Stack;
  const verifier = options.verifyRegistration ?? installedVerifier;
  const verify = (options.runtimeMapsStacks ?? runtimeMapsStacks()) ? verifier : undefined;
  attachDebugIds(frames, buildDebugIdMap(debugIds, parseStack, verify));
}
