import { TraceName } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  ELECTRON_MAIN_HEAP_TRACES,
  ELECTRON_RENDERER_HOST_OWNED_TRACES,
  ELECTRON_RENDERER_NEVER_WRITES,
} from './trace-tables';

describe('Electron trace tables', () => {
  it('main heap is the three ram_js_heap_* names', () => {
    expect([...ELECTRON_MAIN_HEAP_TRACES]).toEqual([
      TraceName.RAM_JS_HEAP_TOTAL,
      TraceName.RAM_JS_HEAP_USED,
      TraceName.RAM_JS_HEAP_FREE,
    ]);
  });
  it('a renderer never writes displays or capture', () => {
    expect([...ELECTRON_RENDERER_NEVER_WRITES].sort()).toEqual(['capture', 'displays']);
  });
  it('the pre-handshake default is the never-written names plus main heap', () => {
    expect([...ELECTRON_RENDERER_HOST_OWNED_TRACES].sort()).toEqual([
      'capture',
      'displays',
      'ram_js_heap_free',
      'ram_js_heap_total',
      'ram_js_heap_used',
    ]);
  });
});
