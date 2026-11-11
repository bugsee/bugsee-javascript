import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createStampedBundleVerifier, readStampedDebugId } from './debug-id-verifier';

const ID = '11111111-2222-5333-8444-555555555555';

describe('readStampedDebugId', () => {
  it('returns the LAST stamp, lower-cased, only when it is a UUID', () => {
    expect(
      readStampedDebugId(`x\n//# debugId=${ID.toUpperCase()}\n//# sourceMappingURL=a.map`),
    ).toBe(ID);
    expect(readStampedDebugId(`//# debugId=${ID}\n//# debugId=${ID.replace('1', '2')}`)).toBe(
      ID.replace('1', '2'),
    );
    expect(readStampedDebugId('//# debugId=not-a-uuid')).toBeUndefined();
    expect(readStampedDebugId('no stamp')).toBeUndefined();
  });
});

describe('createStampedBundleVerifier', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const fixture = (): string => {
    dir = mkdtempSync(join(tmpdir(), 'bugsee-verify-'));
    mkdirSync(join(dir, 'dist'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'dist', 'app.js'), `console.log(1);\n//# debugId=${ID}\n`);
    writeFileSync(join(dir, 'src', 'main.js'), 'export const a = 1;\n');
    return dir;
  };

  it('accepts a file whose tail carries the registered id, rejects an unstamped or differently stamped one', () => {
    const root = fixture();
    const verify = createStampedBundleVerifier({ appRoot: root });
    expect(verify(join(root, 'dist', 'app.js'), ID)).toBe(true);
    expect(verify(join(root, 'dist', 'app.js'), ID.toUpperCase())).toBe(true);
    expect(verify(join(root, 'dist', 'app.js'), 'other')).toBe(false);
    expect(verify(join(root, 'src', 'main.js'), ID)).toBe(false);
  });

  it('resolves app-relative (scrubbed) paths and file:// URLs', () => {
    const root = fixture();
    const verify = createStampedBundleVerifier({ appRoot: root });
    expect(verify('./dist/app.js', ID)).toBe(true);
    expect(verify('./src/main.js', ID)).toBe(false);
    expect(verify(pathToFileURL(join(root, 'dist', 'app.js')).href, ID)).toBe(true);
  });

  it('rejects (never throws) for an unreadable file or a malformed URL', () => {
    const root = fixture();
    const verify = createStampedBundleVerifier({ appRoot: root });
    expect(verify(join(root, 'missing.js'), ID)).toBe(false);
    expect(verify('file://bad host/x', ID)).toBe(false);
  });

  it('reads only the tail of a large file', () => {
    const root = fixture();
    writeFileSync(join(root, 'dist', 'big.js'), `${'a'.repeat(100_000)}\n//# debugId=${ID}\n`);
    writeFileSync(join(root, 'dist', 'head.js'), `//# debugId=${ID}\n${'a'.repeat(100_000)}`);
    const verify = createStampedBundleVerifier({ appRoot: root });
    expect(verify('./dist/big.js', ID)).toBe(true);
    expect(verify('./dist/head.js', ID)).toBe(false);
  });

  it('defaults the app root to the working directory', () => {
    const verify = createStampedBundleVerifier();
    expect(verify('./definitely/not/here.js', ID)).toBe(false);
  });
});
