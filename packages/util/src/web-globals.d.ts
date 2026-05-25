// Ambient declarations for the Web-standard globals @bugsee/util relies on. These exist on
// every target runtime (browser, Node >=18, Bun, Deno, Workers) but are not in the ES2023 lib.
// Declared here — rather than pulling in the DOM lib — to keep this tier-0 package
// runtime-agnostic (no `window`/`document` leaking into its type surface).

declare function btoa(data: string): string;
declare function atob(data: string): string;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

// Minimal `node:crypto` surface used by the SHA-256 fallback (sha256.ts), declared locally so
// the package needs neither @types/node nor a global `crypto` to typecheck. The dynamic import
// only executes on runtimes without global WebCrypto.
declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: Uint8Array): { digest(): Uint8Array };
  };
}
