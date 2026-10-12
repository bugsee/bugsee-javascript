// Durable storage for the user identifier (iOS persists `setUserIdentifier` across launches; web parity).
//
// Deliberately NARROWER than the device-id machinery (device-id.ts), which mirrors one value across
// localStorage + cookie + Cookie Store + IndexedDB + Cache API so it survives a "clear site data". An
// identifier is the app's PII (often an email): it must live in exactly ONE first-party store, never in a
// cookie (cookies are sent to the server on every request), and clearing site data SHOULD forget it. So:
// per-app-token localStorage only, last-writer-wins across tabs, read once at launch.
//
// Every access is wrapped. A blocked/throwing storage (private mode, quota, disabled cookies) reports
// through `onError` and degrades to the in-memory Environment value, which is always authoritative.

export const USER_IDENTIFIER_KEY_PREFIX = 'bugsee.user_identifier.';

/** The localStorage subset used. Injectable for tests. */
export interface UserIdentifierStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface UserIdentifierStore {
  /** The persisted identifier, or null when absent / unreadable. Never throws. */
  read(): string | null;
  /** Persist `id`. Never throws. */
  write(id: string): void;
  /** Remove the persisted identifier. Never throws. */
  clear(): void;
}

export interface UserIdentifierStoreOptions {
  /** Storage seam. `undefined` → `globalThis.localStorage`; `null` → no storage (inert store). */
  storage?: UserIdentifierStorage | null;
  onError?: (error: unknown) => void;
}

export function createUserIdentifierStore(
  appToken: string,
  options: UserIdentifierStoreOptions = {},
): UserIdentifierStore {
  const key = `${USER_IDENTIFIER_KEY_PREFIX}${appToken}`;
  const report = (error: unknown): void => options.onError?.(error);
  // Resolved lazily and inside try: merely touching `globalThis.localStorage` throws SecurityError when
  // storage is blocked.
  const resolve = (): UserIdentifierStorage | null =>
    options.storage === undefined
      ? ((globalThis as { localStorage?: UserIdentifierStorage }).localStorage ?? null)
      : options.storage;
  return {
    read() {
      try {
        const value = resolve()?.getItem(key);
        return typeof value === 'string' && value !== '' ? value : null;
      } catch (error) {
        report(error);
        return null;
      }
    },
    write(id) {
      try {
        resolve()?.setItem(key, id);
      } catch (error) {
        report(error);
        // The new value did not land: leaving the previous one would restore the PREVIOUS user's identifier on
        // the next load, so drop it (best effort).
        try {
          resolve()?.removeItem(key);
        } catch {
          // storage is unusable; nothing more can be done
        }
      }
    },
    clear() {
      try {
        resolve()?.removeItem(key);
      } catch (error) {
        report(error);
      }
    },
  };
}
