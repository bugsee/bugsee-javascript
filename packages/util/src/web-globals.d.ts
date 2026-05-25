// Ambient declarations for the Web-standard globals @bugsee/util relies on. These exist on
// every target runtime (browser, Node >=18, Bun, Deno, Workers) but are not in the ES2023 lib.
// Declared here — rather than pulling in the DOM lib — to keep this tier-0 package
// runtime-agnostic (no `window`/`document` leaking into its type surface).

declare function btoa(data: string): string;
declare function atob(data: string): string;

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare const crypto: {
  readonly subtle: {
    digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  };
};
