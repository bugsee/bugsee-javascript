import type { StackFrame } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createBrowserFrameEnricher } from './stackless-error-context';

const importFailure = () => {
  const message =
    'Failed to fetch dynamically imported module: https://app.example.com/chunk-ABC123.js';
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}`;
  return error;
};
const frame = (file: string): StackFrame => ({ file, line: 1, column: 1 }) as StackFrame;

describe('createBrowserFrameEnricher', () => {
  it('names the failed module for a stackless import failure', () => {
    const out = createBrowserFrameEnricher()(importFailure(), [], { depth: 0 });
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).toContain('chunk-ABC123.js');
  });

  it('leaves a real stack untouched', () => {
    const frames = [frame('app.js')];
    expect(createBrowserFrameEnricher()(importFailure(), frames, { depth: 0 })).toBe(frames);
  });

  it('runs the async-origin enricher first, and the stackless one only for what is still empty', () => {
    // Appends to what it is given, so the ORDER is observable: run second it would see the import frame as well.
    const origin = (_e: unknown, frames: StackFrame[]) => [...frames, frame('call-site.js')];
    // The origin enricher supplied a frame, so the stackless enricher must not add its own.
    const first = createBrowserFrameEnricher(origin)(importFailure(), [], { depth: 0 });
    expect(first).toHaveLength(1);
    expect(JSON.stringify(first)).toContain('call-site.js');
    expect(JSON.stringify(first)).not.toContain('chunk-ABC123.js');
    // An origin enricher with nothing to say falls through to the stackless one.
    const out = createBrowserFrameEnricher((_e, f) => f)(importFailure(), [], { depth: 0 });
    expect(JSON.stringify(out)).toContain('chunk-ABC123.js');
  });
});
