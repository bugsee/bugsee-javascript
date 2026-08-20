import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { defaultDeleteMapFiles, uploadSourcemaps } from './orchestrate';
import type { SpawnResult } from './run-cli';

/**
 * Property-based tests for the two destructive/decision surfaces of the orchestration.
 *
 * `defaultDeleteMapFiles` UNLINKS FILES IN THE USER'S WORKING TREE, driven by an output directory the
 * plugin does not control — a relative `output.file` resolves it to `'.'`, the project root. The example
 * tests pin the shapes someone thought of; the properties below are the invariants that must hold over
 * ANY tree: it never deletes something that is not a build map, never reaches into an excluded or hidden
 * directory at any depth, and its return value is the truth about what is gone.
 *
 * `uploadSourcemaps` is then checked as a state machine: deletion happens if and only if an upload was
 * actually confirmed.
 */

/** The exclusion contract, stated independently of the implementation's own Set. */
const NEVER_WALK = [
  'node_modules',
  'src',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  'test',
  'tests',
  '__tests__',
];
const MAX_DELETE_DEPTH = 6;

const DIRS = [
  'dist',
  'assets',
  'chunks',
  'nested',
  'a',
  'b',
  'node_modules',
  'src',
  'test',
  'tests',
  '__tests__',
  '.git',
  '.cache',
  '.vercel',
  '.turbo',
];
const FILES = ['app.js.map', 'vendor.css.map', 'x.map', 'app.js', 'index.html', 'app.map.js'];

const filePath = fc
  .tuple(fc.array(fc.constantFrom(...DIRS), { maxLength: 8 }), fc.constantFrom(...FILES))
  .map(([dirs, file]) => [...dirs, file]);
const tree = fc.uniqueArray(filePath, {
  maxLength: 14,
  selector: (p) => p.join('/'),
});

const isExcluded = (segments: string[]): boolean =>
  segments.slice(0, -1).some((d) => NEVER_WALK.includes(d) || d.startsWith('.'));
const isTooDeep = (segments: string[]): boolean => segments.length - 1 > MAX_DELETE_DEPTH;
const isMap = (segments: string[]): boolean => (segments.at(-1) as string).endsWith('.map');

const exists = async (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

describe('defaultDeleteMapFiles — properties over arbitrary trees', () => {
  it('deletes ONLY build maps it is allowed to reach, and its return value is the truth', async () => {
    await fc.assert(
      fc.asyncProperty(tree, async (paths) => {
        const root = await mkdtemp(join(tmpdir(), 'bugsee-fuzz-'));
        try {
          for (const segments of paths) {
            const full = join(root, ...segments);
            await mkdir(join(full, '..'), { recursive: true });
            await writeFile(full, 'x');
          }
          const deleted = await defaultDeleteMapFiles(root);
          const deletedRel = new Set(deleted.map((p) => p.slice(root.length + 1)));

          for (const segments of paths) {
            const key = segments.join(sep);
            const shouldGo = isMap(segments) && !isExcluded(segments) && !isTooDeep(segments);
            // SAFETY: nothing else may be touched — not a .js, not an authored map under src/, not
            // anything below a hidden directory, however deep the leading-dot directory sits.
            expect(deletedRel.has(key)).toBe(shouldGo);
            // TRUTHFULNESS: the returned list is exactly what is gone from disk.
            expect(await exists(join(root, ...segments))).toBe(!shouldGo);
          }
          expect(deletedRel.size).toBe(
            paths.filter((s) => isMap(s) && !isExcluded(s) && !isTooDeep(s)).length,
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 60 },
    );
  });

  it('is idempotent — a second walk over the same tree deletes nothing more', async () => {
    await fc.assert(
      fc.asyncProperty(tree, async (paths) => {
        const root = await mkdtemp(join(tmpdir(), 'bugsee-fuzz2-'));
        try {
          for (const segments of paths) {
            const full = join(root, ...segments);
            await mkdir(join(full, '..'), { recursive: true });
            await writeFile(full, 'x');
          }
          await defaultDeleteMapFiles(root);
          expect(await defaultDeleteMapFiles(root)).toEqual([]);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 40 },
    );
  });
});

describe('uploadSourcemaps — deletion happens IFF an upload was confirmed', () => {
  it('never deletes on a dry run or a failure, always deletes after a real upload', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.boolean(), { nil: undefined }),
        async (dryRun, failing, deleteMaps) => {
          const deleteMapFiles = vi.fn(async () => ['/out/app.js.map']);
          const run = vi.fn(async (): Promise<SpawnResult> => {
            if (failing) throw new Error('cli failed');
            return { code: 0, stdout: '', stderr: '' };
          });
          const result = await uploadSourcemaps({
            outDir: '/out',
            appToken: 'tok',
            appVersion: '1.0.0',
            appBuild: '1',
            dryRun,
            deleteMaps,
            run,
            deleteMapFiles,
            onError: () => undefined,
          });
          const uploaded = !failing && !dryRun;
          expect(result.uploaded).toBe(uploaded);
          // Deleting the maps without a confirmed upload destroys the only copy of the mapping.
          const shouldDelete = uploaded && deleteMaps !== false;
          expect(deleteMapFiles).toHaveBeenCalledTimes(shouldDelete ? 1 : 0);
          expect(result.deletedMaps).toEqual(shouldDelete ? ['/out/app.js.map'] : []);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('rejects an empty app token for every other combination of options', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), async (dryRun, failOnError) => {
        const run = vi.fn(async (): Promise<SpawnResult> => ({ code: 0, stdout: '', stderr: '' }));
        await expect(
          uploadSourcemaps({
            outDir: '/out',
            appToken: '',
            appVersion: '1',
            appBuild: '1',
            dryRun,
            failOnError,
            run,
          }),
        ).rejects.toThrow('appToken is required');
        // …and it fails BEFORE touching the CLI, so a misconfigured build spawns nothing.
        expect(run).not.toHaveBeenCalled();
      }),
      { numRuns: 50 },
    );
  });
});
