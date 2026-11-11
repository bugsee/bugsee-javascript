import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseV8Stack } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createStampedBundleVerifier, readStampedDebugId } from './debug-id-verifier';

// Hex LETTERS on purpose: an all-digit id cannot tell a case-folding mutation from the original.
const ID = 'abcdef12-2222-5ABC-8444-55555555dEaD';
const LOWER = ID.toLowerCase();

describe('readStampedDebugId', () => {
  it('returns the LAST stamp, lower-cased, only when it is a UUID', () => {
    expect(readStampedDebugId(`x\n//# debugId=${ID}\n//# sourceMappingURL=a.map`)).toBe(LOWER);
    expect(readStampedDebugId(`//# debugId=${ID}\n//# debugId=${LOWER.replace('a', 'b')}`)).toBe(
      LOWER.replace('a', 'b'),
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
    expect(verify(join(root, 'dist', 'app.js'), LOWER)).toBe(true);
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
    expect(verify('/%zz/not-decodable.mjs', ID)).toBe(false);
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

  describe('ESM frames as the REAL parse pipeline delivers them (parseV8Stack output)', () => {
    // Node prints ESM frames as `file:///…` URLs; core's scrubber strips the scheme WITHOUT decoding, so the
    // verifier sees `/…/my%20app/dist/app.mjs`, not a file:// URL.
    const topFile = (url: string): string => {
      const frame = parseV8Stack(`Error\n    at <anonymous> (${url}:1:479)`)[0];
      return frame?.file as string;
    };

    it('opens a path with a space (percent-encoded in the stack)', () => {
      const root = fixture();
      const spaced = join(root, 'my app', 'dist');
      mkdirSync(spaced, { recursive: true });
      writeFileSync(join(spaced, 'app.mjs'), `export {};\n//# debugId=${ID}\n`);
      const url = pathToFileURL(join(spaced, 'app.mjs')).href;
      expect(url).toContain('my%20app');
      const file = topFile(url);
      expect(file).toContain('my%20app'); // the scrubber really leaves it encoded
      expect(createStampedBundleVerifier({ appRoot: root })(file, ID)).toBe(true);
    });

    it('strips an import query / hash', () => {
      const root = fixture();
      writeFileSync(join(root, 'dist', 'app.mjs'), `export {};\n//# debugId=${ID}\n`);
      const url = `${pathToFileURL(join(root, 'dist', 'app.mjs')).href}?v=1#x`;
      const file = topFile(url);
      expect(file.endsWith('app.mjs?v=1#x')).toBe(true);
      expect(createStampedBundleVerifier({ appRoot: root })(file, ID)).toBe(true);
    });

    it('prefers a file literally named with a query/percent over the decoded reading', () => {
      const root = fixture();
      writeFileSync(join(root, 'dist', 'a%20b.js'), `//# debugId=${ID}\n`);
      expect(
        createStampedBundleVerifier({ appRoot: root })(join(root, 'dist', 'a%20b.js'), ID),
      ).toBe(true);
    });

    it('Windows drive form: tries the decoded URL reading of `/C:/…` (verified through the read seam)', () => {
      const file = topFile('file:///C:/my%20app/dist/app.mjs');
      expect(file).toBe('/C:/my%20app/dist/app.mjs');
      const opened: string[] = [];
      const verify = createStampedBundleVerifier({
        appRoot: '/x',
        readTail: (path) => {
          opened.push(path);
          if (path.includes('my app')) return `//# debugId=${ID}`;
          throw new Error('ENOENT');
        },
      });
      expect(verify(file, ID)).toBe(true);
      // literal first (fails), then the decoded form (what a win32 host turns into `C:\my app\dist\app.mjs`)
      expect(opened[0]).toBe('/C:/my%20app/dist/app.mjs');
      expect(opened[1]).toContain('C:');
      expect(opened[1]).toContain('my app');
    });
  });

  describe('cache', () => {
    it('answers a repeated (file, id) with no further I/O, and caches rejections too', () => {
      let reads = 0;
      const verify = createStampedBundleVerifier({
        appRoot: '/x',
        readTail: (path) => {
          reads++;
          if (path.endsWith('good.js')) return `//# debugId=${ID}`;
          throw new Error('ENOENT');
        },
      });
      expect(verify('/x/good.js', ID)).toBe(true);
      const afterFirst = reads;
      expect(verify('/x/good.js', ID)).toBe(true);
      expect(reads).toBe(afterFirst);
      expect(verify('/x/bad.js', ID)).toBe(false);
      const afterBad = reads;
      expect(verify('/x/bad.js', ID)).toBe(false);
      expect(reads).toBe(afterBad);
      // a different id for the same file is a different question
      expect(verify('/x/good.js', 'other-id')).toBe(false);
    });

    it('is bounded: after many distinct keys it still answers correctly', () => {
      let reads = 0;
      const verify = createStampedBundleVerifier({
        appRoot: '/x',
        readTail: () => {
          reads++;
          return `//# debugId=${ID}`;
        },
      });
      for (let i = 0; i < 600; i++) expect(verify(`/x/f${i}.js`, ID)).toBe(true);
      const before = reads;
      expect(verify('/x/f599.js', ID)).toBe(true); // recent: still cached
      expect(reads).toBe(before);
      expect(verify('/x/f0.js', ID)).toBe(true); // evicted: re-read, same answer
      expect(reads).toBe(before + 1);
    });
  });
});
