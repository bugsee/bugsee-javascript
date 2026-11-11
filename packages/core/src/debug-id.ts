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

/**
 * Build a `file → debugId` map from the registration map: parse each registered stack and key the debug-ID
 * by its TOP frame's file (the bundle that registered it).
 */
export function buildDebugIdMap(
  debugIds: Record<string, string>,
  parseStack: (stack: string) => StackFrame[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [stack, debugId] of Object.entries(debugIds)) {
    const file = parseStack(stack)[0]?.file;
    if (file !== undefined) {
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

/**
 * Resolve + stamp debug-IDs onto `frames` in place, reading the registration global (default `globalThis`)
 * and parsing registered stacks with `parseStack` (default {@link parseV8Stack}). A no-op when no build
 * injected debug-IDs.
 *
 * Also a no-op when the runtime maps stacks itself ({@link runtimeMapsStacks}; override via
 * `options.runtimeMapsStacks`). Then the frames are ALREADY original-source positions and the registration key's
 * top frame was mapped too, so the `file -> debugId` join is meaningless: a frame landing in the file the stub
 * happened to map to would be stamped with the bundle's id and the backend would remap an already-mapped
 * position (a wrong line). An unstamped, already-original frame is correct; a stamped one is not. (Trade-off: a
 * deployment that runs with the flag but ships NO map files gets unmapped frames without an id, i.e. the same
 * appVersion/appBuild fallback as having no plugin.)
 */
export function applyDebugIds(
  frames: StackFrame[],
  options: {
    globalObject?: unknown;
    parseStack?: (stack: string) => StackFrame[];
    runtimeMapsStacks?: boolean;
  } = {},
): void {
  if (options.runtimeMapsStacks ?? runtimeMapsStacks()) {
    return;
  }
  const globalObject = options.globalObject ?? (globalThis as unknown);
  const debugIds = readDebugIds(globalObject);
  if (Object.keys(debugIds).length === 0) {
    return;
  }
  const parseStack = options.parseStack ?? parseV8Stack;
  attachDebugIds(frames, buildDebugIdMap(debugIds, parseStack));
}
