import { strToU8, zipSync } from '@bugsee/util';

// Bundle ZIP assembly (design §7.7 trigger path, §8.4 layout). Given the root-level files the
// pipeline has already serialized (request.json, manifest.json, apptoken, and the typed buffer
// files), produce the `*.bundle.zip` byte payload for the signed-URL PUT.

export interface BundleFile {
  /** Root-level filename within the zip (§8.4). */
  name: string;
  /** File content; strings are UTF-8 encoded, byte arrays are stored as-is. */
  data: Uint8Array | string;
}

export function writeBundleZip(files: readonly BundleFile[]): Uint8Array {
  const entries = new Map<string, Uint8Array>();
  for (const file of files) {
    // fflate reads each entry's value via `obj[name]`, so a "__proto__" name would hit the prototype
    // accessor (returning the wrong value and crashing fflate). It can't be represented; reject it.
    if (file.name === '__proto__') {
      throw new Error('Bundle file name "__proto__" is not allowed');
    }
    if (entries.has(file.name)) {
      throw new Error(`Bundle has a duplicate file name: ${file.name}`);
    }
    entries.set(file.name, typeof file.data === 'string' ? strToU8(file.data) : file.data);
  }
  return zipSync(Object.fromEntries(entries));
}
