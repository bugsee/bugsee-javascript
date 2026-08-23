// Wire units (design §8.6). The environment envelope's memory/disk figures are BINARY MEGABYTES on
// every Bugsee SDK — Android's EnvironmentInfoProvider divides the raw byte count by 1024/1024 before
// putting `platform.memory_total`/`memory_free` on the wire, and the viewer renders those fields by
// dividing by 1024 again and labelling the result GB. A byte count sent into that pipeline is off by
// 1024^2 and displays as an absurd figure (64 GiB of RAM read back as "67,108,864 GB"), so the
// conversion lives here, next to the contract it belongs to, rather than being re-derived per platform.

/**
 * Byte count → whole binary megabytes, truncated (Android's `(int)` cast parity).
 *
 * Anything that is not a finite, positive byte count maps to 0: a failed probe reading must not put
 * NaN (which serializes to null and renders as a blank row) or a negative memory figure on the wire.
 */
export function bytesToMegabytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 0;
  }
  return Math.floor(bytes / 1024 / 1024);
}
