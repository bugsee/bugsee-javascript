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
 * Resolve + stamp debug-IDs onto `frames` in place, reading the registration global (default `globalThis`)
 * and parsing registered stacks with `parseStack` (default {@link parseV8Stack}). A no-op when no build
 * injected debug-IDs.
 */
export function applyDebugIds(
  frames: StackFrame[],
  options: { globalObject?: unknown; parseStack?: (stack: string) => StackFrame[] } = {},
): void {
  const globalObject = options.globalObject ?? (globalThis as unknown);
  const debugIds = readDebugIds(globalObject);
  if (Object.keys(debugIds).length === 0) {
    return;
  }
  const parseStack = options.parseStack ?? parseV8Stack;
  attachDebugIds(frames, buildDebugIdMap(debugIds, parseStack));
}
