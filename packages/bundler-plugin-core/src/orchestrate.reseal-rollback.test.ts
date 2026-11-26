// A re-seal that fails must leave the build as the bundler emitted it. The stamp is already undone when it does not
// verify (step 1b); the re-seal rewrites more than the stamp touched (pages, server modules, runtime tables), so it
// is undone the same way, from its own snapshot, and nothing is uploaded for bundles that went back unstamped.
// Real `bugsee-cli` for the stamp; only the re-seal (or its verdict) is made to fail.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadSourcemaps } from './orchestrate';
import { resolveBugseeCli, runBugseeCli } from './run-cli';
import { resealIntegrity } from './sri';

const cli = resolveBugseeCli();
const probe = cli.endsWith('.js')
  ? spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  : spawnSync(cli, ['--version'], { encoding: 'utf8' });
const required = process.env.CI !== undefined || process.env.BUGSEE_REQUIRE_CLI !== undefined;
const describeReal = probe.status === 0 || required ? describe : describe.skip;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sha384 = (text: string) => `sha384-${createHash('sha384').update(text).digest('base64')}`;

/** An output directory with one hashed bundle + map, a page pinning it, and an SSR copy of the page elsewhere. */
function build() {
  const root = mkdtempSync(join(tmpdir(), 'bugsee-rollback-'));
  made.push(root);
  const out = join(root, 'browser');
  const server = join(root, 'server');
  mkdirSync(out);
  mkdirSync(server);
  const js = 'console.log(1);\n//# sourceMappingURL=main.js.map\n';
  writeFileSync(join(out, 'main.js'), js);
  writeFileSync(
    join(out, 'main.js.map'),
    JSON.stringify({ version: 3, file: 'main.js', sources: ['a.ts'], names: [], mappings: 'AAAA' }),
  );
  const page = `<script src="main.js" integrity="${sha384(js)}"></script>`;
  writeFileSync(join(out, 'index.html'), page);
  writeFileSync(join(out, 'about.html'), '<p>no hashes</p>');
  writeFileSync(join(server, 'index.html.mjs'), `export default ${JSON.stringify(page)};`);
  return { root, out, server };
}

/** A verifier whose pins are fine until the stamp ran: the first call (before) is clean, later ones report `pins`. */
const brokenAfterStamp = (pins: { html: string; script: string; integrity: string }[]) => {
  let calls = 0;
  return async () => (calls++ === 0 ? [] : pins);
};

const snapshot = (...dirs: string[]) =>
  Object.fromEntries(
    dirs.flatMap((dir) =>
      readdirSync(dir).map((name) => [join(dir, name), readFileSync(join(dir, name), 'utf8')]),
    ),
  );

const options = (out: string, server: string, extra: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const run = vi.fn(async (args: string[], o: Parameters<typeof runBugseeCli>[1]) => {
    calls.push(args[0] === 'debug-files' ? 'upload' : args.slice(0, 2).join(' '));
    if (args[0] === 'debug-files') {
      return { code: 0, stdout: '', stderr: '' };
    }
    return runBugseeCli(args, o);
  });
  const errors: unknown[] = [];
  return {
    calls,
    errors,
    opts: {
      outDir: out,
      appToken: 'tok',
      appVersion: '1',
      appBuild: '1',
      resealSri: true,
      resealDirs: [out, server],
      run,
      onError: (e: unknown) => errors.push(e),
      ...extra,
    },
  };
};

describeReal('uploadSourcemaps re-seal rollback', () => {
  it('seals a good build (control): page verifies, upload runs', async () => {
    const { out, server } = build();
    const { opts, calls, errors } = options(out, server);
    const result = await uploadSourcemaps(opts);
    expect(errors).toEqual([]);
    expect(result.uploaded).toBe(true);
    expect(calls).toContain('upload');
  });

  it('puts every original byte back when the re-seal throws midway, and uploads nothing', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts, calls, errors } = options(out, server, {
      reseal: async () => {
        // It had already written one file when the disk failed.
        writeFileSync(join(out, 'index.html'), 'HALF-SEALED');
        throw new Error('ENOSPC: no space left on device');
      },
    });
    const result = await uploadSourcemaps(opts);
    expect(snapshot(out, server)).toEqual(before);
    expect(calls).not.toContain('upload');
    expect(result).toMatchObject({ injected: false, uploaded: false, deletedMaps: [] });
    const message = String(errors[0]);
    expect(message).toContain('ENOSPC');
    expect(message).toMatch(/restored/);
  });

  it('puts every original byte back when a hash is still stale after the re-seal, and uploads nothing', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts, calls, errors } = options(out, server, {
      verifySri: brokenAfterStamp([
        { html: join(out, 'index.html'), script: join(out, 'main.js'), integrity: 'sha384-X' },
      ]),
    });
    const result = await uploadSourcemaps(opts);
    expect(snapshot(out, server)).toEqual(before);
    expect(calls).not.toContain('upload');
    expect(result).toMatchObject({ injected: false, uploaded: false });
    expect(String(errors[0])).toContain('still does not match');
    // Only what changed is put back: main.js, its map and the two copies of the page, not about.html.
    expect(String(errors[0])).toContain('(4 file(s))');
    // The maps were not deleted either: the unstamped bundles still need them if the user opts out of SRI.
    expect(readdirSync(out)).toContain('main.js.map');
  });

  it('brings back a file the failed re-seal removed', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts } = options(out, server, {
      reseal: async () => {
        rmSync(join(out, 'index.html'));
        throw new Error('boom');
      },
    });
    await uploadSourcemaps(opts);
    expect(snapshot(out, server)).toEqual(before);
  });

  it('reports a re-seal that rejects with something that is not an Error', async () => {
    const { out, server } = build();
    const { opts, errors } = options(out, server, {
      reseal: async () => {
        throw 'plain string failure';
      },
    });
    await uploadSourcemaps(opts);
    expect(String(errors[0])).toContain('plain string failure');
  });

  it('removes the temporary copies of the originals it took', async () => {
    const { out, server, root } = build();
    const spillRoot = join(root, 'spill');
    mkdirSync(spillRoot);
    const { opts } = options(out, server, { spillRoot });
    await uploadSourcemaps(opts);
    expect(readdirSync(spillRoot)).toEqual([]);
  });

  it('still reports the inject failure when putting the files back also fails', async () => {
    const { out, server } = build();
    const { opts, errors } = options(out, server, {
      restoreFile: async () => {
        throw new Error('EPERM');
      },
      run: async (args: string[], o: Parameters<typeof runBugseeCli>[1]) => {
        if (args[1] === 'inject') {
          await runBugseeCli(args, o);
          throw new Error('bugsee-cli exited 1 on a later file');
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await uploadSourcemaps(opts);
    expect(String(errors[0])).toContain('later file');
  });

  it('throws the failure under failOnError, after restoring', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts } = options(out, server, {
      failOnError: true,
      reseal: async () => {
        throw new Error('EACCES');
      },
    });
    await expect(uploadSourcemaps(opts)).rejects.toThrow(/EACCES/);
    expect(snapshot(out, server)).toEqual(before);
  });

  it('restores everything when a service worker manifest still does not match its files, and uploads nothing', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts, calls, errors } = options(out, server, {
      verifyServiceWorker: async () => [{ manifest: join(out, 'ngsw.json'), url: '/main.js' }],
    });
    const result = await uploadSourcemaps(opts);
    expect(snapshot(out, server)).toEqual(before);
    expect(calls).not.toContain('upload');
    expect(result).toMatchObject({ injected: false, uploaded: false });
    expect(String(errors[0])).toContain('ngsw.json');
    expect(String(errors[0])).toContain('/main.js');
    expect(String(errors[0])).toMatch(/restored/);
  });

  it('restores everything when an old digest is still present in the server modules after the re-seal', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts, calls, errors } = options(out, server, {
      verifyDigests: async () => [
        { file: join(server, 'index.html.mjs'), script: join(out, 'main.js') },
      ],
    });
    const result = await uploadSourcemaps(opts);
    expect(snapshot(out, server)).toEqual(before);
    expect(calls).not.toContain('upload');
    expect(result).toMatchObject({ injected: false, uploaded: false });
    expect(String(errors[0])).toContain('index.html.mjs');
    expect(String(errors[0])).toMatch(/restored/);
  });

  it('rolls back when the server copy of the page was not re-sealed (the browser pages alone look fine)', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts, calls, errors } = options(out, server, {
      // Re-seals the browser directory only, so index.html verifies but the server module keeps the old digest.
      reseal: (digests: Parameters<typeof resealIntegrity>[0]) => resealIntegrity(digests, [out]),
    });
    const result = await uploadSourcemaps(opts);
    expect(snapshot(out, server)).toEqual(before);
    expect(calls).not.toContain('upload');
    expect(result).toMatchObject({ injected: false, uploaded: false });
    expect(String(errors[0])).toContain('index.html.mjs');
  });

  it('verifies the page pins over every verifyDirs, and a mismatch in a later one rolls the build back', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const seen: string[] = [];
    const { opts, calls, errors } = options(out, server, {
      verifyDirs: [out, server],
      verifySri: async (dir: string) => {
        seen.push(dir);
        return seen.length > 2 && dir === server
          ? [
              {
                html: join(server, 'fr/index.html'),
                script: join(server, 'fr/main.js'),
                integrity: 'sha384-X',
              },
            ]
          : [];
      },
    });
    const result = await uploadSourcemaps(opts);
    expect(seen).toEqual([out, server, out, server]); // before the stamp, then after the re-seal
    expect(snapshot(out, server)).toEqual(before);
    expect(calls).not.toContain('upload');
    expect(result).toMatchObject({ injected: false, uploaded: false });
    expect(String(errors[0])).toContain('fr/main.js');
  });

  it('verifies the output directory alone when no verifyDirs is given', async () => {
    const { out, server } = build();
    const seen: string[] = [];
    const { opts } = options(out, server, {
      verifySri: async (dir: string) => {
        seen.push(dir);
        return [];
      },
    });
    await uploadSourcemaps(opts);
    expect(seen).toEqual([out, out]);
  });

  // A pin that was already wrong before we touched anything (a page pinning a file another step changed) is not ours:
  // it is said, and it must not roll back a re-seal that did its job.
  it('does not roll back for a pin that was already broken before the stamp, and says so', async () => {
    const { out, server } = build();
    writeFileSync(join(out, 'vendor.js'), 'vendor();');
    writeFileSync(
      join(out, 'other.html'),
      `<script src="vendor.js" integrity="${sha384('NOT THE FILE')}"></script>`,
    );
    const { opts, calls, errors } = options(out, server, { verifyDirs: [out] });
    const notices: string[] = [];
    const result = await uploadSourcemaps({ ...opts, onNotice: (m: string) => notices.push(m) });
    expect(errors).toEqual([]);
    expect(result.uploaded).toBe(true);
    expect(calls).toContain('upload');
    expect(notices.join('\n')).toMatch(/even before the stamp.*vendor\.js/s);
  });

  it('still rolls back for a pin that WAS valid and is broken after', async () => {
    const { out, server } = build();
    let call = 0;
    const { opts, calls } = options(out, server, {
      // before the stamp nothing is wrong; after the re-seal one page is
      verifySri: async () =>
        call++ === 0
          ? []
          : [
              {
                html: join(out, 'index.html'),
                script: join(out, 'main.js'),
                integrity: 'sha384-X',
              },
            ],
    });
    const result = await uploadSourcemaps(opts);
    expect(result).toMatchObject({ injected: false, uploaded: false });
    expect(calls).not.toContain('upload');
  });

  it('a pre-existing bad pin that a re-seal run cannot make worse is not a failure, but a NEW one beside it is', async () => {
    const { out, server } = build();
    const old = { html: join(out, 'a.html'), script: join(out, 'v.js'), integrity: 'sha384-A' };
    const fresh = {
      html: join(out, 'index.html'),
      script: join(out, 'main.js'),
      integrity: 'sha384-B',
    };
    let call = 0;
    const { opts, errors } = options(out, server, {
      verifySri: async () => (call++ === 0 ? [old] : [old, fresh]),
    });
    await uploadSourcemaps(opts);
    expect(String(errors[0])).toContain('main.js');
    expect(String(errors[0])).not.toContain('(and');
  });

  // The re-seal machinery (digest snapshot, a second spill of every file, the swap walk, the verify) is only worth
  // its cost when something can need it: a page that pins a hash, or a service worker manifest.
  it('skips the re-seal for an SSR layout too when no page and no server module holds a digest and there is no manifest', async () => {
    const { out, server } = build();
    writeFileSync(join(out, 'index.html'), '<p>no pins</p>');
    writeFileSync(join(server, 'index.html.mjs'), 'export default "<p>no pins</p>";');
    const snapshotDigests = vi.fn(async () => new Map());
    const { opts } = options(out, server, { snapshotDigests, resealDirs: [out, server] });
    await uploadSourcemaps(opts);
    expect(snapshotDigests).not.toHaveBeenCalled();
  });

  it('reports a file it could not put back after a failed inject, naming it', async () => {
    const { out, server } = build();
    const { opts, errors } = options(out, server, {
      restoreFile: async (_spill: string, target: string) => {
        throw new Error(`EBUSY ${target}`);
      },
      run: async (args: string[], o: Parameters<typeof runBugseeCli>[1]) => {
        if (args[1] === 'inject') {
          await runBugseeCli(args, o);
          throw new Error('bugsee-cli exited 1 on a later file');
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    await uploadSourcemaps(opts);
    const message = String(errors[0]);
    expect(message).toContain('later file');
    expect(message).toMatch(/COULD NOT restore.*EBUSY.*still stamped/s);
  });

  it('does NOT skip the re-seal when it covers more than the output directory: the server modules may hold the pin', async () => {
    const { out, server } = build();
    writeFileSync(join(out, 'index.html'), '<p>no pins</p>'); // only the server module embeds a page
    const snapshotDigests = vi.fn(async () => new Map());
    const { opts } = options(out, server, { snapshotDigests, resealDirs: [out, server] });
    await uploadSourcemaps(opts);
    expect(snapshotDigests).toHaveBeenCalled();
  });

  it('puts every byte back when inject fails AFTER it stamped (a later batch fails): no stamped bundle against an un-sealed page', async () => {
    const { out, server } = build();
    const before = snapshot(out, server);
    const { opts, calls, errors } = options(out, server, {
      run: async (args: string[], o: Parameters<typeof runBugseeCli>[1]) => {
        if (args[1] === 'inject') {
          await runBugseeCli(args, o); // stamped on disk...
          throw new Error('bugsee-cli exited 1 on a later file'); // ...then the command fails
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const result = await uploadSourcemaps(opts);
    expect(snapshot(out, server)).toEqual(before);
    expect(calls).not.toContain('upload');
    expect(result).toMatchObject({ injected: false, uploaded: false });
    expect(String(errors[0])).toContain('later file');
  });

  it('skips the whole re-seal when nothing pins a hash and there is no service worker manifest', async () => {
    const { out, server } = build();
    writeFileSync(join(out, 'index.html'), '<p>no pins</p>');
    const snapshotDigests = vi.fn(async () => new Map());
    const reseal = vi.fn(async () => ({ files: [] }));
    const { opts } = options(out, server, {
      snapshotDigests,
      reseal,
      resealDirs: [out],
      spillRoot: join(out, '..'),
    });
    await uploadSourcemaps(opts);
    expect(snapshotDigests).not.toHaveBeenCalled();
    expect(reseal).not.toHaveBeenCalled();
  });

  it('still re-seals a service worker manifest when no page pins a hash', async () => {
    const { out, server } = build();
    writeFileSync(join(out, 'index.html'), '<p>no pins</p>');
    const js = readFileSync(join(out, 'main.js'), 'utf8');
    writeFileSync(
      join(out, 'ngsw.json'),
      JSON.stringify({ hashTable: { '/main.js': createHash('sha1').update(js).digest('hex') } }),
    );
    const { opts, errors } = options(out, server, { resealDirs: [out] });
    await uploadSourcemaps(opts);
    expect(errors).toEqual([]);
    const table = JSON.parse(readFileSync(join(out, 'ngsw.json'), 'utf8')).hashTable;
    expect(table['/main.js']).toBe(
      createHash('sha1')
        .update(readFileSync(join(out, 'main.js')))
        .digest('hex'),
    );
    expect(table['/main.js']).not.toBe(createHash('sha1').update(js).digest('hex'));
  });

  it('seals a build with a real service worker manifest (control)', async () => {
    const { out, server } = build();
    const js = readFileSync(join(out, 'main.js'), 'utf8');
    const sha1 = (t: string) => createHash('sha1').update(t).digest('hex');
    writeFileSync(
      join(out, 'ngsw.json'),
      JSON.stringify({ hashTable: { '/main.js': sha1(js) } }, null, 2),
    );
    const { opts, calls, errors } = options(out, server);
    const result = await uploadSourcemaps(opts);
    expect(errors).toEqual([]);
    expect(result.uploaded).toBe(true);
    expect(calls).toContain('upload');
    const manifest = JSON.parse(readFileSync(join(out, 'ngsw.json'), 'utf8'));
    expect(manifest.hashTable['/main.js']).toBe(sha1(readFileSync(join(out, 'main.js'), 'utf8')));
    expect(manifest.hashTable['/main.js']).not.toBe(sha1(js));
  });

  it('names a file it could not restore', async () => {
    const { out, server } = build();
    const { opts, errors } = options(out, server, {
      verifySri: brokenAfterStamp([
        { html: join(out, 'index.html'), script: join(out, 'main.js'), integrity: 'sha384-X' },
      ]),
      restoreFile: async (_spill: string, target: string) => {
        throw new Error(`EPERM on ${target}`);
      },
    });
    await uploadSourcemaps(opts);
    expect(String(errors[0])).toMatch(/COULD NOT restore/);
    expect(String(errors[0])).toContain('EPERM');
  });
});
