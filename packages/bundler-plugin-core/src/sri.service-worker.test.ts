// Angular's service worker manifest (`ngsw.json`, one per locale for a localized build) holds `hashTable`: the SHA-1
// (hex) of every file it caches, keyed by URL. A service worker that finds a file whose hash differs treats the app as
// corrupt and stops serving it. Measured on @angular/build 22.3 + @angular/service-worker: every entry is
// sha1(file bytes), the key is the path from the manifest's directory, and the file is formatted JSON.
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findStaleDigests,
  findStaleServiceWorkerEntries,
  listResealFiles,
  resealIntegrity,
  snapshotScriptDigests,
} from './sri';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sha = (alg: string, text: string) => createHash(alg).update(text).digest('base64');
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
const manifest = (table: Record<string, string>) =>
  JSON.stringify({ configVersion: 1, index: '/index.html', hashTable: table }, null, 2);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bugsee-ngsw-'));
  made.push(root);
});
const write = async (rel: string, body: string) => {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body, 'utf8');
  return full;
};

describe('findStaleDigests', () => {
  it('reports every file under the directories that still holds the old digest of a changed script', async () => {
    await write('browser/main.js', 'a();');
    await write('browser/keep.js', 'k();');
    const page = `<script integrity="sha384-${sha('sha384', 'a();')}"></script>`;
    const html = await write('browser/index.html', page);
    const mjs = await write(
      'server/assets/index.html.mjs',
      `export default ${JSON.stringify(page)};`,
    );
    await write('server/notes.txt', page);
    const before = await snapshotScriptDigests([join(root, 'browser')]);
    await write('browser/main.js', 'a();\n//# debugId=x');
    const stale = await findStaleDigests(before, [root]);
    expect(stale.map((s) => s.file).sort()).toEqual([html, mjs].sort());
    expect(stale[0]?.script).toBe(join(root, 'browser/main.js'));
    await resealIntegrity(before, [root]);
    expect(await findStaleDigests(before, [root])).toEqual([]);
  });

  it('lists a file once even when it holds the old digests of several changed scripts', async () => {
    await write('a.js', 'a();');
    await write('b.js', 'b();');
    const page = await write(
      'index.html',
      `sha384-${sha('sha384', 'a();')} sha384-${sha('sha384', 'b();')}`,
    );
    const before = await snapshotScriptDigests([root]);
    await write('a.js', 'a2();');
    await write('b.js', 'b2();');
    expect(await findStaleDigests(before, [root])).toEqual([
      { file: page, script: expect.stringMatching(/[ab]\.js$/) },
    ]);
  });

  it('says nothing when no script changed, or a changed script is gone', async () => {
    await write('browser/main.js', 'a();');
    await write('browser/index.html', `sha384-${sha('sha384', 'a();')}`);
    const before = await snapshotScriptDigests([join(root, 'browser')]);
    expect(await findStaleDigests(before, [root])).toEqual([]);
    await rm(join(root, 'browser/main.js'));
    expect(await findStaleDigests(before, [root])).toEqual([]);
  });

  it('checks every algorithm', async () => {
    await write('a.js', 'a();');
    const before = await snapshotScriptDigests([root]);
    await write('a.js', 'b();');
    for (const alg of ['sha256', 'sha512']) {
      const page = await write(`p-${alg}.html`, `${alg}-${sha(alg, 'a();')}`);
      expect((await findStaleDigests(before, [root])).map((s) => s.file)).toContain(page);
    }
  });
});

describe('service worker manifests', () => {
  it('re-computes the hash of a file that was stamped or re-sealed, leaving the formatting alone', async () => {
    await write('main.js', 'a();');
    await write(
      'index.html',
      `<script src="main.js" integrity="sha384-${sha('sha384', 'a();')}"></script>`,
    );
    const html0 = await readFile(join(root, 'index.html'), 'utf8');
    await write('favicon.ico', 'ico');
    const ngsw = await write(
      'ngsw.json',
      manifest({
        '/main.js': sha1('a();'),
        '/index.html': sha1(html0),
        '/favicon.ico': sha1('ico'),
      }),
    );
    const before = await snapshotScriptDigests([root]);
    await write('main.js', 'a();\n//# debugId=x');
    const { files } = await resealIntegrity(before, [root]);
    expect(files).toContain(ngsw);
    const html1 = await readFile(join(root, 'index.html'), 'utf8');
    expect(await readFile(ngsw, 'utf8')).toBe(
      manifest({
        '/main.js': sha1('a();\n//# debugId=x'),
        '/index.html': sha1(html1),
        '/favicon.ico': sha1('ico'),
      }),
    );
    expect(await findStaleServiceWorkerEntries([root])).toEqual([]);
  });

  it('does it for the manifest of every locale', async () => {
    for (const locale of ['en-US', 'fr']) {
      await write(`${locale}/main.js`, `${locale}();`);
      await write(`${locale}/ngsw.json`, manifest({ '/main.js': sha1(`${locale}();`) }));
    }
    const before = await snapshotScriptDigests([root]);
    await write('fr/main.js', 'fr();\n//# debugId=y');
    await resealIntegrity(before, [root]);
    expect(await findStaleServiceWorkerEntries([root])).toEqual([]);
    expect(await readFile(join(root, 'en-US/ngsw.json'), 'utf8')).toContain(sha1('en-US();'));
    expect(await readFile(join(root, 'fr/ngsw.json'), 'utf8')).toContain(
      sha1('fr();\n//# debugId=y'),
    );
  });

  it('finds the file under a base href, by dropping leading path segments', async () => {
    await write('main.js', 'a();');
    await write('ngsw.json', manifest({ '/app/v2/main.js': sha1('a();') }));
    await write('main.js', 'changed');
    expect(await findStaleServiceWorkerEntries([root])).toEqual([
      { manifest: join(root, 'ngsw.json'), url: '/app/v2/main.js' },
    ]);
    await resealIntegrity(new Map(), [root]);
    expect(await findStaleServiceWorkerEntries([root])).toEqual([]);
  });

  it('leaves an entry whose file is not there, and a manifest that is not JSON or has no table', async () => {
    await write('d/a.js', 'a');
    const files = [
      await write('a/ngsw.json', manifest({ '/gone.js': sha1('x') })),
      await write('b/ngsw.json', '{ nope'),
      await write('c/ngsw.json', '{"index":"/"}'),
      await write('d/ngsw.json', '{"hashTable":{"/a.js":5}}'),
    ];
    const texts = await Promise.all(files.map((f) => readFile(f, 'utf8')));
    await resealIntegrity(new Map(), [root]);
    expect(await Promise.all(files.map((f) => readFile(f, 'utf8')))).toEqual(texts);
    expect(await findStaleServiceWorkerEntries([root])).toEqual([]);
  });

  it('hashes a large listed asset by streaming it (no whole-file buffer), and still reconciles it', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    await mkdir(join(root, 'media'), { recursive: true });
    await writeFile(join(root, 'media/clip.bin'), big);
    await write('ngsw.json', manifest({ '/media/clip.bin': 'stale' }));
    expect(await findStaleServiceWorkerEntries([root])).toHaveLength(1);
    await resealIntegrity(new Map(), [root]);
    expect(await readFile(join(root, 'ngsw.json'), 'utf8')).toContain(
      createHash('sha1').update(big).digest('hex'),
    );
  });

  it('an entry that names a directory is skipped, like one whose file is gone', async () => {
    await mkdir(join(root, 'assets'), { recursive: true });
    await write('ngsw.json', manifest({ '/assets': 'x' }));
    expect(await findStaleServiceWorkerEntries([root])).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    'a file it cannot read is an error, not a silent skip',
    async () => {
      const secret = await write('locked.js', 'x');
      await write('ngsw.json', manifest({ '/locked.js': sha1('x') }));
      await chmod(secret, 0o000);
      try {
        await expect(findStaleServiceWorkerEntries([root])).rejects.toThrow(/EACCES/);
      } finally {
        await chmod(secret, 0o644);
      }
    },
  );

  it('does not look in node_modules, and does not follow a key out of the manifest directory', async () => {
    await write('node_modules/p/ngsw.json', manifest({ '/m.js': 'x' }));
    await write('outside.js', 'o');
    await write('sub/ngsw.json', manifest({ '/../outside.js': 'stale' }));
    expect(await findStaleServiceWorkerEntries([root])).toEqual([]);
  });

  it('lists the manifests among the files a re-seal may rewrite', async () => {
    const ngsw = await write('x/ngsw.json', '{}');
    expect(await listResealFiles([root])).toContain(ngsw);
  });
});
