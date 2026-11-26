import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findServerRoot, isStrictlyInside } from './server-root';
import { uploadAngularSourcemaps } from './upload';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'bugsee-ng-root-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const dir = (rel: string) => mkdir(join(cwd, rel), { recursive: true });
const file = async (rel: string) => {
  await dir(join(rel, '..'));
  await writeFile(join(cwd, rel), 'x();');
};

describe('isStrictlyInside', () => {
  it('is true for a descendant, false for the directory itself, a parent, a sibling and another drive', () => {
    expect(isStrictlyInside('/p/a/b', '/p')).toBe(true);
    expect(isStrictlyInside('/p', '/p')).toBe(false);
    expect(isStrictlyInside('/', '/p')).toBe(false);
    expect(isStrictlyInside('/q/a', '/p')).toBe(false);
  });

  it('a directory whose name merely starts with two dots is inside', () => {
    expect(isStrictlyInside('/p/..out/browser', '/p')).toBe(true);
  });

  it('on Windows a different drive is not inside (relative() answers with an absolute path)', () => {
    expect(isStrictlyInside('D:\\out\\app', 'C:\\proj', win32)).toBe(false);
    expect(isStrictlyInside('C:\\proj\\out\\app', 'C:\\proj', win32)).toBe(true);
  });
});

describe('findServerRoot', () => {
  it('finds the output root of an application build from its browser directory', async () => {
    await file('o/browser/main.js');
    await dir('o/server');
    expect(findServerRoot(join(cwd, 'o/browser'), cwd)).toEqual({
      root: join(cwd, 'o'),
      browser: join(cwd, 'o/browser'),
    });
  });

  it('finds it from a locale directory of a localized build', async () => {
    await file('o/browser/fr/main.js');
    await dir('o/server/fr');
    expect(findServerRoot(join(cwd, 'o/browser/fr'), cwd)).toEqual({
      root: join(cwd, 'o'),
      browser: join(cwd, 'o/browser'),
    });
  });

  it('does not take an unrelated server/ for the output root, and says it could not tell', async () => {
    await file('o/dist/main.js');
    await file('o/server/server.mjs');
    const found = findServerRoot(join(cwd, 'o/dist'), cwd);
    expect(found).toMatchObject({ notice: expect.stringContaining('browser') });
    expect((found as { notice: string }).notice).toMatch(/browser\/ name/);
  });

  it('a custom browser directory name (outputPath.browser) is not guessed: it is said', async () => {
    await file('o/client/fr/main.js');
    await file('o/server/fr/main.server.mjs');
    expect(findServerRoot(join(cwd, 'o/client/fr'), cwd)).toMatchObject({
      notice: expect.stringContaining('o/server'),
    });
  });

  // A server/ that is not an Angular SSR output is nobody's business: no notice on every CI run.
  it('says nothing about a hand-written server/ (Express beside Angular) or a backend next to a client dist', async () => {
    await file('server/index.js'); // project root server/
    await file('dist/main.js');
    expect(findServerRoot(join(cwd, 'dist'), cwd)).toBeUndefined();
    await file('apps/dist/client/main.js');
    await file('apps/dist/server/app.js'); // a backend build, no Angular server markers
    expect(findServerRoot(join(cwd, 'apps/dist/client'), cwd)).toBeUndefined();
  });

  it.each([
    'server.mjs',
    'main.server.mjs',
    'index.server.html',
    'angular-app-manifest.mjs',
    'angular-app-engine-manifest.mjs',
  ])('recognises an Angular server output by %s', async (marker) => {
    await file('o/client/main.js');
    await file(`o/server/${marker}`);
    expect(findServerRoot(join(cwd, 'o/client'), cwd)).toMatchObject({
      notice: expect.any(String),
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    'an unreadable server/ is not taken for an Angular one',
    async () => {
      await file('o/client/main.js');
      await file('o/server/server.mjs');
      await chmod(join(cwd, 'o/server'), 0o000);
      try {
        expect(findServerRoot(join(cwd, 'o/client'), cwd)).toBeUndefined();
      } finally {
        await chmod(join(cwd, 'o/server'), 0o755);
      }
    },
  );

  it('an unmatched server/ outside the project is not reported either', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'bugsee-ng-outside2-'));
    try {
      await mkdir(join(outside, 'server'));
      await writeFile(join(outside, 'server', 'server.mjs'), '');
      await mkdir(join(outside, 'client'));
      expect(findServerRoot(join(outside, 'client'), cwd)).toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('names the NEAREST unmatched server/ when two levels both have one', async () => {
    await file('o/x/y/main.js');
    await file('o/x/server/server.mjs');
    await file('o/server/server.mjs');
    const found = findServerRoot(join(cwd, 'o/x/y'), cwd) as { notice: string };
    expect(found.notice).toContain(join(cwd, 'o/x/server'));
    expect(found.notice).not.toContain(join(cwd, 'o/server'));
  });

  it('looks at most two levels up: a root three levels above is not found', async () => {
    await file('o/browser/a/b/main.js');
    await file('o/server/server.mjs');
    expect(findServerRoot(join(cwd, 'o/browser/a/b'), cwd)).toBeUndefined();
  });

  it('finds nothing without a server/', async () => {
    await file('o/browser/fr/main.js');
    expect(findServerRoot(join(cwd, 'o/browser/fr'), cwd)).toBeUndefined();
    expect(findServerRoot(join(cwd, 'o/browser'), cwd)).toBeUndefined();
  });

  it('does not follow a symlinked server/, and says nothing', async () => {
    await file('o/browser/main.js');
    await dir('elsewhere');
    await symlink(join(cwd, 'elsewhere'), join(cwd, 'o/server'));
    expect(findServerRoot(join(cwd, 'o/browser'), cwd)).toBeUndefined();
  });

  it('works under a directory whose name starts with two dots', async () => {
    await file('..out/browser/main.js');
    await dir('..out/server');
    expect(findServerRoot(join(cwd, '..out/browser'), cwd)).toEqual({
      root: join(cwd, '..out'),
      browser: join(cwd, '..out/browser'),
    });
  });

  it('says it cannot widen when the output root is the project root, instead of re-sealing the project', async () => {
    await file('browser/main.js');
    await dir('server');
    const found = findServerRoot(join(cwd, 'browser'), cwd);
    expect(found).toMatchObject({ notice: expect.stringContaining('server') });
    expect((found as { notice: string }).notice).toMatch(/--output-path/);
  });

  it('says so when the output root is outside the project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'bugsee-ng-outside-'));
    try {
      await mkdir(join(outside, 'browser'));
      await mkdir(join(outside, 'server'));
      const found = findServerRoot(join(outside, 'browser'), cwd);
      expect(found).toMatchObject({ notice: expect.stringContaining('outside') });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('uploadAngularSourcemaps: the server pages are re-sealed whichever way the output is named', () => {
  const ran = () =>
    vi.fn(async (_r: unknown, _d: string, _deps: Record<string, unknown>) => ({
      injected: true,
      uploaded: true,
      deletedMaps: [],
    }));
  const base = (extra: Record<string, unknown>, notices: string[] = []) => ({
    cwd,
    appToken: 'tok',
    vcs: false,
    env: {},
    onNotice: (m: string) => notices.push(m),
    ...extra,
  });
  const build = async () => {
    await file('o/browser/fr/main.js');
    await file('o/browser/fr/main.js.map');
    await dir('o/server/fr');
  };

  it('--dist <browser>/<locale>', async () => {
    await build();
    const run = ran();
    await uploadAngularSourcemaps(base({ dist: 'o/browser/fr' }), { runPluginUpload: run });
    // Only the stamped locale and ITS server counterpart: Angular emits byte-identical shared scripts into every
    // locale, so re-sealing the whole root would pin never-stamped scripts of the other locales to stamped digests.
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      resealDirs: [join(cwd, 'o/browser/fr'), join(cwd, 'o/server/fr')],
      verifyDirs: [join(cwd, 'o')],
    });
  });

  it('--dist <browser> (all locales stamped) re-seals the whole root and verifies it', async () => {
    await build();
    const run = ran();
    await uploadAngularSourcemaps(base({ dist: 'o/browser' }), { runPluginUpload: run });
    expect(run.mock.calls[0]?.[2]).toMatchObject({
      resealDirs: [join(cwd, 'o')],
      verifyDirs: [join(cwd, 'o')],
    });
  });

  it('--output-path <browser dir> (a flat reading of an application output)', async () => {
    await build();
    const run = ran();
    await uploadAngularSourcemaps(base({ outputPath: 'o/browser' }), { runPluginUpload: run });
    expect(run.mock.calls[0]?.[2]).toMatchObject({ resealDirs: [join(cwd, 'o')] });
  });

  it('--output-path <base> with a browser/ but no server/ is browser-only, and verifies only it', async () => {
    await file('b/browser/main.js');
    const run = ran();
    await uploadAngularSourcemaps(base({ outputPath: 'b' }), { runPluginUpload: run });
    const deps = run.mock.calls[0]?.[2] as { resealDirs: string[]; verifyDirs?: string[] };
    expect(deps.resealDirs).toEqual([join(cwd, 'b/browser')]);
    expect(deps.verifyDirs).toEqual([join(cwd, 'b/browser')]);
  });

  it('a nested --dist with no server/ keeps the browser directory only', async () => {
    await file('o/browser/fr/main.js');
    const run = ran();
    await uploadAngularSourcemaps(base({ dist: 'o/browser/fr' }), { runPluginUpload: run });
    expect(run.mock.calls[0]?.[2]).toMatchObject({ resealDirs: [join(cwd, 'o/browser/fr')] });
  });

  it('the project root as output root is said, and not widened', async () => {
    await file('browser/main.js');
    await dir('server');
    const run = ran();
    const notices: string[] = [];
    await uploadAngularSourcemaps(base({ dist: 'browser' }, notices), { runPluginUpload: run });
    expect(run.mock.calls[0]?.[2]).toMatchObject({ resealDirs: [join(cwd, 'browser')] });
    expect(notices.join('\n')).toMatch(/server.*project root/s);
  });
});
