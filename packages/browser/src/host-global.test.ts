import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundMatchMedia, hostGlobal, hostRead } from './host-global';
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
  it('ui breadcrumb source with a throwing global performance (timeOrigin)', () => {
    saved.set('performance', Object.getOwnPropertyDescriptor(globalThis, 'performance'));
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      get(): never {
        throw new Error('performance blocked');
      },
    });
    expect(() => createUiBreadcrumbSource({ target: undefined })).not.toThrow();
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

describe('hostRead / boundMatchMedia', () => {
  it('hostRead returns the value, or undefined and a report when the read throws', () => {
    expect(hostRead(() => 5)).toBe(5);
    const errors: unknown[] = [];
    expect(
      hostRead(
        () => {
          throw new Error('blocked');
        },
        (e) => errors.push(e),
      ),
    ).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('boundMatchMedia binds to the window, and is undefined for no window, no method, or a throwing getter (reported)', () => {
    const seen: unknown[] = [];
    const win = {
      matchMedia(this: unknown, q: string) {
        seen.push(this, q);
        return {} as MediaQueryList;
      },
    };
    boundMatchMedia(win)?.('(x)');
    expect(seen).toEqual([win, '(x)']);
    const none: unknown[] = [];
    expect(boundMatchMedia(undefined, (e) => none.push(e))).toBeUndefined();
    expect(none).toEqual([]); // no window is a plain absence, not a failure
    expect(boundMatchMedia({})).toBeUndefined();
    const hostile = {};
    Object.defineProperty(hostile, 'matchMedia', {
      get(): never {
        throw new Error('blocked');
      },
    });
    const errors: unknown[] = [];
    expect(boundMatchMedia(hostile, (e) => errors.push(e))).toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
