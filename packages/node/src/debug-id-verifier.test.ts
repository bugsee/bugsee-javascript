import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseV8Stack, setStackAppRoot } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createStampedBundleVerifier, readStampedDebugId } from './debug-id-verifier';

// Hex LETTERS on purpose: an all-digit id cannot tell a case-folding mutation from the original.
const ID = 'abcdef12-2222-5ABC-8444-55555555dEaD';
const LOWER = ID.toLowerCase();
const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

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
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'bugsee-verify-')));
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
          throw enoent();
        },
      });
      expect(verify(file, ID)).toBe(true);
      // literal first (fails), then the decoded form (what a win32 host turns into `C:\my app\dist\app.mjs`)
      expect(opened[0]).toBe('/C:/my%20app/dist/app.mjs');
      expect(opened[1]).toContain('C:');
      expect(opened[1]).toContain('my app');
    });
  });

  it('falls back to the literal path when a real directory name is not a valid file-URL reading', () => {
    const root = fixture();
    for (const name of ['100%', 'a%2Fb']) {
      mkdirSync(join(root, name, 'dist'), { recursive: true });
      writeFileSync(join(root, name, 'dist', 'app.js'), `//# debugId=${ID}\n`);
      expect(
        createStampedBundleVerifier({ appRoot: root })(join(root, name, 'dist', 'app.js'), ID),
      ).toBe(true);
    }
  });

  describe('transient read errors', () => {
    it('are rejected but NOT cached: the next call asks again', () => {
      let reads = 0;
      let failing = true;
      const verify = createStampedBundleVerifier({
        appRoot: '/x',
        readTail: () => {
          reads++;
          if (failing) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
          return `//# debugId=${ID}`;
        },
      });
      expect(verify('/x/a.js', ID)).toBe(false);
      expect(verify('/x/a.js', ID)).toBe(false);
      expect(reads).toBe(2); // one distinct reading per ask, asked twice
      failing = false;
      expect(verify('/x/a.js', ID)).toBe(true);
      expect(verify('/x/a.js', ID)).toBe(true);
      expect(reads).toBe(3); // the success is cached
    });

    it('an error without a code is transient too; a malformed URL is rejected uncached', () => {
      let reads = 0;
      const verify = createStampedBundleVerifier({
        appRoot: '/x',
        readTail: () => {
          reads++;
          throw new Error('mystery');
        },
      });
      expect(verify('/x/a.js', ID)).toBe(false);
      expect(verify('/x/a.js', ID)).toBe(false);
      expect(reads).toBe(2);
      expect(verify('file://bad host/x', ID)).toBe(false);
    });
  });

  describe('ESM frames UNDER the app root (scrubbed to `./…`, still percent-encoded)', () => {
    afterEach(() => setStackAppRoot(undefined));
    // The common case: launch() sets appRoot = cwd, so core rewrites `file:///<root>/dist/x.mjs` to `./dist/x.mjs`
    // WITHOUT decoding. Every test here feeds the verifier the real output of parseV8Stack with that root set.
    const frameFile = (root: string, rel: string, suffix = ''): string => {
      setStackAppRoot(root);
      const url = `${pathToFileURL(join(root, rel)).href}${suffix}`;
      return parseV8Stack(`Error\n    at <anonymous> (${url}:1:479)`)[0]?.file as string;
    };
    const stamped = (root: string, rel: string): void => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), `export {};\n//# debugId=${ID}\n`);
    };

    it('decodes a space in the file name', () => {
      const root = fixture();
      stamped(root, 'dist/my chunk.mjs');
      const file = frameFile(root, 'dist/my chunk.mjs');
      expect(file).toBe('./dist/my%20chunk.mjs');
      expect(createStampedBundleVerifier({ appRoot: root })(file, ID)).toBe(true);
    });

    it('decodes braces / brackets / percent-encoded characters', () => {
      const root = fixture();
      stamped(root, 'dist/[id]-{x}.mjs');
      const file = frameFile(root, 'dist/[id]-{x}.mjs');
      expect(createStampedBundleVerifier({ appRoot: root })(file, ID)).toBe(true);
    });

    it('strips an import query and a hash', () => {
      const root = fixture();
      stamped(root, 'dist/a.mjs');
      for (const suffix of ['?v=1', '#h', '?v=1#h']) {
        const file = frameFile(root, 'dist/a.mjs', suffix);
        expect(file).toBe(`./dist/a.mjs${suffix}`);
        expect(createStampedBundleVerifier({ appRoot: root })(file, ID)).toBe(true);
      }
    });

    it('decodes AND strips together; rejects an unstamped file', () => {
      const root = fixture();
      stamped(root, 'dist/my chunk.mjs');
      const file = frameFile(root, 'dist/my chunk.mjs', '?v=2');
      expect(createStampedBundleVerifier({ appRoot: root })(file, ID)).toBe(true);
      writeFileSync(join(root, 'dist', 'plain.mjs'), 'export {};\n');
      expect(
        createStampedBundleVerifier({ appRoot: root })(
          frameFile(root, 'dist/plain.mjs', '?v=1'),
          ID,
        ),
      ).toBe(false);
    });

    it('a relative path that is not a valid percent-encoding stays literal', () => {
      const root = fixture();
      stamped(root, 'dist/100%.mjs');
      expect(createStampedBundleVerifier({ appRoot: root })('./dist/100%.mjs', ID)).toBe(true);
    });
  });

  it('after stripping a query, tries the literal stripped path (a file really named with a percent)', () => {
    const root = fixture();
    writeFileSync(join(root, 'dist', 'a%20b.mjs'), `//# debugId=${ID}\n`);
    const verify = createStampedBundleVerifier({ appRoot: root });
    // literal `…/a%20b.mjs?v=1` and decoded `…/a b.mjs` do not exist; only the stripped literal does
    expect(verify(`${join(root, 'dist', 'a%20b.mjs')}?v=1`, ID)).toBe(true);
    expect(verify('./dist/a%20b.mjs?v=1', ID)).toBe(true);
  });

  it('keeps trying later candidates when an UNRELATED file sits at the literal reading', () => {
    const root = fixture();
    // the stamped bundle is `a b.mjs`; an unrelated, unstamped file is literally named `a%20b.mjs`
    writeFileSync(join(root, 'dist', 'a b.mjs'), `export {};\n//# debugId=${ID}\n`);
    writeFileSync(join(root, 'dist', 'a%20b.mjs'), 'export {};\n');
    // likewise an unrelated file literally named `q.mjs?v=1` next to the stamped `q.mjs`
    writeFileSync(join(root, 'dist', 'q.mjs'), `export {};\n//# debugId=${ID}\n`);
    writeFileSync(join(root, 'dist', 'q.mjs?v=1'), 'export {};\n');
    const verify = createStampedBundleVerifier({ appRoot: root });
    expect(verify('./dist/a%20b.mjs', ID)).toBe(true);
    expect(verify('./dist/q.mjs?v=1', ID)).toBe(true);
    // ...and a file that is genuinely not stamped under any reading is still rejected
    expect(verify('./dist/plain-missing%20x.mjs', ID)).toBe(false);
  });

  it('opens each distinct reading once (deduped), and treats NUL / invalid-arg paths as a definitive miss', () => {
    const opened: string[] = [];
    let reads = 0;
    const verify = createStampedBundleVerifier({
      appRoot: '/x',
      readTail: (path) => {
        reads++;
        opened.push(path);
        throw Object.assign(new Error('bad path'), { code: 'ERR_INVALID_ARG_VALUE' });
      },
    });
    expect(verify('/x/plain.js', ID)).toBe(false);
    expect(opened).toEqual(['/x/plain.js']); // literal === decoded: opened once
    const after = reads;
    expect(verify('/x/plain.js', ID)).toBe(false);
    expect(reads).toBe(after); // cached as definitive
    expect(verify('./dist/a%00b.mjs', ID)).toBe(false);
    const nul = reads;
    expect(verify('./dist/a%00b.mjs', ID)).toBe(false);
    expect(reads).toBe(nul);
  });

  describe('NODE_OPTIONS token handling is delegated to core; verifier cache', () => {
    it('caches a definitive miss for every no-such-file code, including EINVAL (the win32 `/C:/` literal)', () => {
      for (const code of ['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EISDIR', 'EINVAL']) {
        let reads = 0;
        const verify = createStampedBundleVerifier({
          appRoot: '/x',
          readTail: () => {
            reads++;
            throw Object.assign(new Error(code), { code });
          },
        });
        expect(verify('/x/a.js', ID)).toBe(false);
        const first = reads;
        expect(verify('/x/a.js', ID)).toBe(false);
        expect(reads).toBe(first);
      }
    });

    it('holds a realistic number of registrations without evicting (no re-reads at 1000 chunks)', () => {
      let reads = 0;
      const verify = createStampedBundleVerifier({
        appRoot: '/x',
        readTail: () => {
          reads++;
          return `//# debugId=${ID}`;
        },
      });
      for (let i = 0; i < 1000; i++) verify(`/x/c${i}.js`, ID);
      const before = reads;
      for (let i = 0; i < 1000; i++) verify(`/x/c${i}.js`, ID);
      expect(reads).toBe(before);
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
          throw enoent();
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
      for (let i = 0; i < 5000; i++) expect(verify(`/x/f${i}.js`, ID)).toBe(true);
      const before = reads;
      expect(verify('/x/f4999.js', ID)).toBe(true); // recent: still cached
      expect(reads).toBe(before);
      expect(verify('/x/f0.js', ID)).toBe(true); // evicted: re-read, same answer
      expect(reads).toBe(before + 1);
    });
  });
});
