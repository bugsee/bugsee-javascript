import { parseLocation, parseV8Stack, type StackFrame } from '@bugsee/core';

// Browser Error.stack parsing — the runtime-dispatching layer core/stack.ts anticipates. Chromium
// emits the V8 dialect (`at fn (loc)`, handled by core's parseV8Stack); Firefox (SpiderMonkey) and
// Safari (JavaScriptCore) emit `fn@loc` (or `@loc` for anonymous). Path scrubbing is single-sourced
// via core's parseLocation. Pure string work — the captured description is formatStack(parseStack(...)).

function parseAtSignFrame(line: string): StackFrame | undefined {
  // SpiderMonkey/JSC frame: "fn@location" or "@location". A function name never contains '@', so the
  // FIRST '@' separates the function from the location. Lines without '@' (e.g. "[native code]") and
  // an empty location are not frames.
  const at = line.indexOf('@');
  if (at === -1) {
    return undefined;
  }
  const location = line.slice(at + 1);
  if (location === '') {
    return undefined;
  }
  const frame = parseLocation(location);
  const fn = line.slice(0, at);
  if (fn !== '') {
    frame.function = fn;
  }
  return frame;
}

/**
 * Parse a browser `Error.stack` into path-scrubbed frames, dispatching by engine dialect: V8/Chromium
 * (`at fn (loc)`) via core's parseV8Stack, else SpiderMonkey/JavaScriptCore (`fn@loc`) via the
 * @-parser. Returns `[]` when no frames are recognized.
 */
export function parseStack(stack: string): StackFrame[] {
  const lines = stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  // A V8 frame line starts with "at " (with the space); the @-dialects never do.
  if (lines.some((line) => line.startsWith('at '))) {
    return parseV8Stack(stack);
  }
  const frames: StackFrame[] = [];
  for (const line of lines) {
    const frame = parseAtSignFrame(line);
    if (frame !== undefined) {
      frames.push(frame);
    }
  }
  return frames;
}
