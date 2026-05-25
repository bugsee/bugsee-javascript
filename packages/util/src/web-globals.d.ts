// Minimal `node:crypto` surface used by the SHA-256 fallback (sha256.ts), declared locally so the
// package needs no @types/node. This is a narrow MODULE augmentation (not a global one), limited
// to the single `createHash(...).update(...).digest()` chain actually used; it merges harmlessly
// with @types/node where present. Web-standard globals (btoa/atob/TextEncoder/crypto) are accessed
// via typed `globalThis` casts in the source, so no global ambient leaks into consumers.
declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: Uint8Array): { digest(): Uint8Array };
  };
}
