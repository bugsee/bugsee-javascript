import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostGlobal } from './host-global';
import { createBrowserInputSource } from './input-source';
import { installPageHideFlush } from './page-lifecycle';
import { createUiBreadcrumbSource } from './ui-breadcrumb-source';
import { createViewtreeSnapshotSource } from './viewtree';

const NAMES = ['window', 'document', 'screen'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

function block(names: readonly string[] = NAMES): void {
  for (const key of names) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get(): never {
        throw new Error(`${key} blocked`);
      },
    });
  }
}
afterEach(() => {
  for (const [key, d] of saved) {
    if (d !== undefined) Object.defineProperty(globalThis, key, d);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  saved.clear();
});

describe('hostGlobal', () => {
  it('returns the global when present and undefined when absent', () => {
    vi.stubGlobal('document', { marker: 1 });
    expect(hostGlobal('document')).toEqual({ marker: 1 });
    vi.unstubAllGlobals();
    expect(hostGlobal('screen')).toBeUndefined();
  });

  it('returns undefined and reports when the read throws; a throwing reporter changes nothing', () => {
    block(['window']);
    const errors: unknown[] = [];
    expect(hostGlobal('window', (e) => errors.push(e))).toBeUndefined();
    expect((errors[0] as Error).message).toBe('window blocked');
    expect(
      hostGlobal('window', () => {
        throw new Error('reporter');
      }),
    ).toBeUndefined();
    expect(hostGlobal('window')).toBeUndefined(); // no reporter at all
  });
});

describe('blocked host globals never throw out of the browser sources (launch must not fail)', () => {
  it('input source', () => {
    block();
    expect(() => createBrowserInputSource({})).not.toThrow();
  });
  it('ui breadcrumb source', () => {
    block();
    expect(() => createUiBreadcrumbSource({})).not.toThrow();
  });
  it('viewtree snapshot source', () => {
    block();
    const source = createViewtreeSnapshotSource({});
    // the document is read lazily at report time, which is where a blocked global would throw
    expect(() => source(0)).not.toThrow();
    expect(source(0)).toEqual([]);
  });
  it('page-hide flush installs nothing instead of throwing', () => {
    block();
    let off: (() => void) | undefined;
    expect(() => {
      off = installPageHideFlush(() => {}, {});
    }).not.toThrow();
    expect(() => off?.()).not.toThrow();
  });
});
