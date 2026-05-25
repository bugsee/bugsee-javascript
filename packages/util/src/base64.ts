// `btoa`/`atob` are Web-standard globals on every target runtime (browser, Node >=16, Bun, Deno,
// Workers). Accessed through a typed view of globalThis so this tier-0 package needs neither the
// DOM lib nor a global ambient declaration that could leak into consumers' type space.
const { btoa, atob } = globalThis as unknown as {
  btoa: (data: string) => string;
  atob: (data: string) => string;
};

/** RFC 4648 base64 encode of binary data. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** RFC 4648 base64 decode to bytes. */
export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
