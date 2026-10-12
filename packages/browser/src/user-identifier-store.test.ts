import { describe, expect, it, vi } from 'vitest';
import {
  createUserIdentifierStore,
  USER_IDENTIFIER_KEY_PREFIX,
  type UserIdentifierStorage,
} from './user-identifier-store';

function memoryStorage(initial: Record<string, string> = {}): UserIdentifierStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

const boom = (): never => {
  throw new Error('SecurityError');
};
const throwingStorage: UserIdentifierStorage = {
  getItem: boom,
  setItem: boom,
  removeItem: boom,
};

describe('createUserIdentifierStore', () => {
  it('round-trips an identifier under a per-token key', () => {
    const storage = memoryStorage();
    const store = createUserIdentifierStore('tok-a', { storage });
    store.write('a@b.c');
    expect([...storage.data.entries()]).toEqual([[`${USER_IDENTIFIER_KEY_PREFIX}tok-a`, 'a@b.c']]);
    expect(store.read()).toBe('a@b.c');
  });

  it('a failed write removes the previous value so a stale identity cannot come back on the next load', () => {
    const storage = memoryStorage();
    const onError = vi.fn();
    const store = createUserIdentifierStore('tok-a', { storage, onError });
    store.write('alice@');
    storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    store.write('bob@');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(store.read()).toBeNull();
  });

  it('a failed write whose cleanup also fails reports once and never throws', () => {
    const onError = vi.fn();
    const store = createUserIdentifierStore('tok-a', { storage: throwingStorage, onError });
    expect(() => store.write('bob@')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('isolates app tokens from each other', () => {
    const storage = memoryStorage();
    createUserIdentifierStore('tok-a', { storage }).write('one');
    expect(createUserIdentifierStore('tok-b', { storage }).read()).toBeNull();
  });

  it('clear removes the stored value', () => {
    const storage = memoryStorage();
    const store = createUserIdentifierStore('t', { storage });
    store.write('x');
    store.clear();
    expect(storage.data.size).toBe(0);
    expect(store.read()).toBeNull();
  });

  it('treats an empty stored value as absent', () => {
    const storage = memoryStorage({ [`${USER_IDENTIFIER_KEY_PREFIX}t`]: '' });
    expect(createUserIdentifierStore('t', { storage }).read()).toBeNull();
  });

  it('never throws on a blocked storage; each failure goes to onError', () => {
    const onError = vi.fn();
    const store = createUserIdentifierStore('t', { storage: throwingStorage, onError });
    expect(store.read()).toBeNull();
    expect(() => store.write('x')).not.toThrow();
    expect(() => store.clear()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it('tolerates failures with no onError configured', () => {
    const store = createUserIdentifierStore('t', { storage: throwingStorage });
    expect(store.read()).toBeNull();
    expect(() => store.write('x')).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });

  it('is inert when there is no storage at all', () => {
    const store = createUserIdentifierStore('t', { storage: null });
    expect(store.read()).toBeNull();
    expect(() => store.write('x')).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });

  it('falls back to globalThis.localStorage by default', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    try {
      createUserIdentifierStore('t').write('g');
      expect(storage.data.get(`${USER_IDENTIFIER_KEY_PREFIX}t`)).toBe('g');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is inert when the host has no localStorage global', () => {
    vi.stubGlobal('localStorage', undefined);
    try {
      expect(createUserIdentifierStore('t').read()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('survives a throwing localStorage getter (blocked cookies)', () => {
    const onError = vi.fn();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { get: boom, configurable: true });
    try {
      const store = createUserIdentifierStore('t', { onError });
      expect(store.read()).toBeNull();
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});
