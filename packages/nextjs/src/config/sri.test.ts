import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isFile, SRI_MANIFEST, sriManifestNear } from './sri';

describe('sriManifestNear', () => {
  const only = (path: string) => async (candidate: string) => candidate === path;

  it('finds the manifest from the client, server and edge output directories', async () => {
    expect(await sriManifestNear('/o/.next', only(`/o/.next/${SRI_MANIFEST}`))).toBe(true);
    const server = '/o/.next/server/subresource-integrity-manifest.json';
    expect(await sriManifestNear('/o/.next/server/chunks', only(server))).toBe(true);
    expect(await sriManifestNear('/o/.next/server', only(server))).toBe(true);
  });

  it('finds nothing when there is none', async () => {
    expect(await sriManifestNear('/o/.next', async () => false)).toBe(false);
  });

  it('looks on the real disk by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-sri-'));
    try {
      expect(await sriManifestNear(dir)).toBe(false);
      mkdirSync(join(dir, 'server'));
      writeFileSync(join(dir, SRI_MANIFEST), '{}');
      expect(await sriManifestNear(dir)).toBe(true);
      expect(await isFile(join(dir, 'server'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
