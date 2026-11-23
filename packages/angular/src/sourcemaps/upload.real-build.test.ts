// The upload step against REAL Angular 22.3 output and the REAL bugsee-cli. The two chunks in
// test/fixtures/angular-22 are byte-for-byte what `ng build` (the esbuild `application` builder, production,
// `sourceMap: { scripts: true, styles: false, hidden: true }`) wrote for an app with the Bugsee SDK, maps included —
// Angular had already put its own `//# debugId` in each. The page around them is assembled here in the exact shape
// `subresourceIntegrity: true` gives it (checked on the same build): `<script src integrity>` for the entry and a
// `<script type="importmap">` integrity table for the lazy chunk, with the page embedded a second time in an SSR
// server module. What a browser then does with the result is verified separately, in Chromium, on a full app
// (see docs/design/source-maps.md §7.1); this proves the bytes and the pipeline on every CI run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findIntegrityMismatches,
  resolveBugseeCli,
  uploadSourcemaps,
} from '@bugsee/bundler-plugin-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uploadAngularSourcemaps } from './upload';

const cli = resolveBugseeCli();
const probe = cli.endsWith('.js')
  ? spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  : spawnSync(cli, ['--version'], { encoding: 'utf8' });
// Locally a missing binary skips with a reason; CI (or BUGSEE_REQUIRE_CLI=1) requires it, so CI cannot go green testing less.
const required = process.env.CI !== undefined || process.env.BUGSEE_REQUIRE_CLI !== undefined;
const describeReal = probe.status === 0 || required ? describe : describe.skip;

const fixtures = fileURLToPath(new URL('../../test/fixtures/angular-22', import.meta.url));
const ENTRY = 'chunk-C4fphy5n.js';
const LAZY = 'chunk-BE0WtcF2.js';
const sha384 = (path: string) =>
  `sha384-${createHash('sha384').update(readFileSync(path)).digest('base64')}`;

let server: Server;
let endpoint: string;
let uploads = 0;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-ng-real-'));
  // Every upload is answered "already uploaded", so it succeeds without a backend.
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      uploads++;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ ok: false, error: { type: 'DuplicateSymbolsFoundError', code: 16004 } }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

/** A workspace whose `ng build` output is the fixture chunks plus a page that pins them by hash. */
function workspace(name: string, options: { ssr?: boolean } = {}) {
  const dir = join(root, name);
  const browser = join(dir, 'dist', 'demo', 'browser');
  mkdirSync(browser, { recursive: true });
  cpSync(fixtures, browser, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '2.4.6' }));
  writeFileSync(
    join(dir, 'angular.json'),
    JSON.stringify({
      projects: {
        demo: {
          projectType: 'application',
          root: '',
          architect: {
            build: {
              builder: '@angular/build:application',
              options: {},
              defaultConfiguration: 'production',
            },
          },
        },
      },
    }),
  );
  const page =
    `<!doctype html><html><head>` +
    `<script type="importmap">${JSON.stringify({ integrity: { [`./${LAZY}`]: sha384(join(browser, LAZY)) } })}</script>` +
    `<base href="/"></head><body><app-root></app-root>` +
    `<script src="${ENTRY}" type="module" crossorigin="anonymous" integrity="${sha384(join(browser, ENTRY))}"></script>` +
    `</body></html>`;
  writeFileSync(join(browser, 'index.html'), page);
  let embedded: string | undefined;
  if (options.ssr) {
    const server = join(dir, 'dist', 'demo', 'server', 'assets-chunks');
    mkdirSync(server, { recursive: true });
    embedded = join(server, 'index.html.mjs');
    writeFileSync(embedded, `export default ${JSON.stringify(page)};\n`);
  }
  return { dir, browser, embedded };
}

describeReal('uploadAngularSourcemaps on real Angular output with subresourceIntegrity', () => {
  it("stamps both bundles, keeps Angular's debug-IDs, re-seals the page, and uploads the maps", async () => {
    const { dir, browser } = workspace('sri');
    const before = {
      entry: readFileSync(join(browser, ENTRY), 'utf8'),
      lazy: readFileSync(join(browser, LAZY), 'utf8'),
    };
    const errors: unknown[] = [];
    uploads = 0;

    const out = await uploadAngularSourcemaps({
      cwd: dir,
      appToken: 'tok',
      endpoint,
      vcs: false,
      registerBuild: false,
      env: {},
      onError: (e) => errors.push(e),
    });

    expect(errors).toEqual([]);
    expect(out.status).toBe('uploaded');
    expect(out.result).toMatchObject({ injected: true, uploaded: true });
    expect(uploads).toBe(2);

    // Stamped: the runtime registration is appended, and the id Angular wrote is the id that is registered.
    for (const [file, original] of [
      [ENTRY, before.entry],
      [LAZY, before.lazy],
    ] as const) {
      const stamped = readFileSync(join(browser, file), 'utf8');
      const id = /\/\/# debugId=([0-9a-f-]{36})/.exec(original)?.[1] as string;
      expect(stamped.startsWith(original)).toBe(true);
      expect(stamped).toContain('_bugseeDebugIds');
      expect(stamped).toContain(`_bugseeDebugIds[n]="${id}"`);
    }
    // Uploaded, so the client maps are gone.
    expect(existsSync(join(browser, `${ENTRY}.map`))).toBe(false);
    expect(existsSync(join(browser, `${LAZY}.map`))).toBe(false);

    // Re-sealed: the page pins what is now on disk, in the script tag and in the import map.
    expect(await findIntegrityMismatches(browser)).toEqual([]);
    const page = readFileSync(join(browser, 'index.html'), 'utf8');
    expect(page).toContain(sha384(join(browser, ENTRY)));
    expect(page).toContain(sha384(join(browser, LAZY)));
  });

  it('also re-seals the copy of the page an SSR build embeds in its server modules', async () => {
    const { dir, browser, embedded } = workspace('ssr', { ssr: true });
    const stale = readFileSync(embedded as string, 'utf8');
    const errors: unknown[] = [];

    await uploadAngularSourcemaps({
      cwd: dir,
      appToken: 'tok',
      endpoint,
      vcs: false,
      registerBuild: false,
      env: {},
      onError: (e) => errors.push(e),
    });

    expect(errors).toEqual([]);
    const fresh = readFileSync(embedded as string, 'utf8');
    expect(fresh).not.toBe(stale);
    expect(fresh).toContain(sha384(join(browser, ENTRY)));
    expect(fresh).toContain(sha384(join(browser, LAZY)));
    // The module is the re-sealed page, byte for byte, as the string Angular wrote it as.
    expect(fresh).toBe(
      `export default ${JSON.stringify(readFileSync(join(browser, 'index.html'), 'utf8'))};\n`,
    );
  });

  it('the guard still refuses to stamp this build WITHOUT re-sealing: the import map is seen', async () => {
    const { browser } = workspace('refused');
    const errors: unknown[] = [];
    const result = await uploadSourcemaps({
      outDir: browser,
      appToken: 'tok',
      appVersion: '1',
      appBuild: '1',
      endpoint,
      onError: (e) => errors.push(e),
    });
    expect(result.injected).toBe(false);
    expect(String(errors[0])).toContain('Subresource Integrity');
    expect(readFileSync(join(browser, LAZY), 'utf8')).not.toContain('_bugseeDebugIds');
  });
});
