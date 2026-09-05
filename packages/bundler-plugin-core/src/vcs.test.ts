import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SpawnFn, SpawnResult } from './run-cli';
import { isWorkingTreeDirty, resolveCommitOverride, resolveVcsMetadata } from './vcs';

/** A `RunFn` that returns fixed stdout for `vcs-metadata` and records its argv. */
function fakeRun(stdout: string): {
  run: (args: string[], options: unknown) => Promise<SpawnResult>;
  calls: { args: string[]; options: unknown }[];
} {
  const calls: { args: string[]; options: unknown }[] = [];
  return {
    calls,
    run: async (args, options) => {
      calls.push({ args, options });
      return { code: 0, stdout, stderr: '' };
    },
  };
}

/** A dirty-checker stub. */
const dirty = async (): Promise<boolean> => true;
const clean = async (): Promise<boolean> => false;
const unknownDirt = async (): Promise<undefined> => undefined;

describe('resolveCommitOverride', () => {
  it('accepts a full 40-char SHA', () => {
    const sha = 'a'.repeat(40);
    expect(resolveCommitOverride(sha, {})).toBe(sha);
  });

  it('accepts a 7-char short SHA and a 64-char sha256 SHA (the appserver bounds)', () => {
    expect(resolveCommitOverride('abc1234', {})).toBe('abc1234');
    expect(resolveCommitOverride('f'.repeat(64), {})).toBe('f'.repeat(64));
  });

  it('accepts mixed case (the appserver regex is case-insensitive)', () => {
    expect(resolveCommitOverride('AbCdEf1', {})).toBe('AbCdEf1');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(resolveCommitOverride(`  ${'a'.repeat(40)}\n`, {})).toBe('a'.repeat(40));
  });

  it('REJECTS a value that is not a hex SHA — a branch name, a tag, "HEAD"', () => {
    expect(resolveCommitOverride('main', {})).toBeUndefined();
    expect(resolveCommitOverride('HEAD', {})).toBeUndefined();
    expect(resolveCommitOverride('v1.2.3', {})).toBeUndefined();
  });

  it('REJECTS a too-short (6) or too-long (65) hex string', () => {
    expect(resolveCommitOverride('abcdef', {})).toBeUndefined();
    expect(resolveCommitOverride('a'.repeat(65), {})).toBeUndefined();
  });

  it('REJECTS an empty string', () => {
    expect(resolveCommitOverride('', {})).toBeUndefined();
    expect(resolveCommitOverride('   ', {})).toBeUndefined();
  });

  it('falls back to BUGSEE_BUILD_COMMIT when no explicit value is given', () => {
    const sha = 'b'.repeat(40);
    expect(resolveCommitOverride(undefined, { BUGSEE_BUILD_COMMIT: sha })).toBe(sha);
  });

  it('prefers the explicit value over the env var', () => {
    const explicit = 'c'.repeat(40);
    expect(resolveCommitOverride(explicit, { BUGSEE_BUILD_COMMIT: 'd'.repeat(40) })).toBe(explicit);
  });

  it('returns undefined when neither is present', () => {
    expect(resolveCommitOverride(undefined, {})).toBeUndefined();
  });

  it('REJECTS an invalid env var rather than falling through to it', () => {
    expect(resolveCommitOverride(undefined, { BUGSEE_BUILD_COMMIT: 'not-a-sha' })).toBeUndefined();
  });
});

describe('resolveVcsMetadata — driving `bugsee-cli vcs-metadata`', () => {
  it('spawns `vcs-metadata --working-dir <root>` and returns the parsed object', async () => {
    const sha = 'a'.repeat(40);
    const { run, calls } = fakeRun(
      `${JSON.stringify({ provider: 'github', commit_sha: sha, branch: 'main', repo: 'o/r' })}\n`,
    );
    const vcs = await resolveVcsMetadata({
      projectRoot: '/proj',
      run,
      checkDirty: clean,
    });
    expect(vcs).toEqual({ provider: 'github', commit_sha: sha, branch: 'main', repo: 'o/r' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['vcs-metadata', '--working-dir', '/proj']);
  });

  it('passes a SHORT timeout, not the 120s upload budget — a build must not hang on a git probe', async () => {
    const { run, calls } = fakeRun('{}');
    await resolveVcsMetadata({ projectRoot: '/proj', run, checkDirty: clean });
    const options = calls[0]?.options as { timeoutMs?: number };
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it('passes the project root as the child cwd, so a relative git discovery agrees with --working-dir', async () => {
    const { run, calls } = fakeRun('{}');
    await resolveVcsMetadata({ projectRoot: '/proj', run, checkDirty: clean });
    expect((calls[0]?.options as { cwd?: string }).cwd).toBe('/proj');
  });

  it('returns undefined for an EMPTY object — the resolver found nothing at all', async () => {
    const { run } = fakeRun('{}');
    expect(await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty: clean })).toBeUndefined();
  });

  it('returns undefined when the CLI FAILS (not installed, non-zero exit) — never throws', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn bugsee-cli ENOENT');
    });
    await expect(
      resolveVcsMetadata({ projectRoot: '/p', run, checkDirty: clean }),
    ).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when stdout is not JSON', async () => {
    const { run } = fakeRun('not json at all');
    expect(await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty: clean })).toBeUndefined();
  });

  it.each([
    // A NON-EMPTY array on purpose: `{...[]}` is `{}`, so an empty one is indistinguishable from a
    // correct rejection and let an "arrays are objects too" mutation survive the whole suite. This one
    // spreads to `{0:'a',1:'b'}` and would be reported as VCS metadata.
    ['an array', '["a","b"]'],
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"abc"'],
    ['a boolean', 'true'],
  ])('returns undefined when stdout parses to %s rather than an object', async (_label, stdout) => {
    const { run } = fakeRun(stdout);
    expect(await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty: clean })).toBeUndefined();
  });

  it('does not spawn anything when disabled', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const checkDirty = vi.fn(clean);
    expect(
      await resolveVcsMetadata({ projectRoot: '/p', enabled: false, run, checkDirty }),
    ).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(checkDirty).not.toHaveBeenCalled();
  });
});

describe('resolveVcsMetadata — the dirty-tree gate', () => {
  const sha = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const full = () =>
    fakeRun(
      JSON.stringify({
        provider: 'github',
        commit_sha: sha,
        base_sha: base,
        branch: 'main',
        repo: 'o/r',
      }),
    );

  it('DROPS commit_sha and base_sha when the working tree is dirty, keeping the rest', async () => {
    const { run } = full();
    const vcs = await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty: dirty });
    // The whole point: a SHA that does not describe the built source would make the backend
    // fetch and display the WRONG lines of code for a crash frame. No source beats wrong source.
    expect(vcs).toEqual({ provider: 'github', branch: 'main', repo: 'o/r' });
    expect(vcs?.commit_sha).toBeUndefined();
    expect(vcs?.base_sha).toBeUndefined();
  });

  it('KEEPS commit_sha on a dirty tree when allowDirtyCommit is opted into', async () => {
    const { run } = full();
    const vcs = await resolveVcsMetadata({
      projectRoot: '/p',
      run,
      checkDirty: dirty,
      allowDirtyCommit: true,
    });
    expect(vcs?.commit_sha).toBe(sha);
    expect(vcs?.base_sha).toBe(base);
  });

  it('KEEPS commit_sha when dirtiness is UNKNOWN (no git, not a repo, a git that errored)', async () => {
    // Unknown must not be treated as dirty: a CI container with no `git` binary still gets a
    // correct SHA from the CI env vars, and dropping it there would disable the feature on the
    // most common deployment shape there is.
    const { run } = full();
    const vcs = await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty: unknownDirt });
    expect(vcs?.commit_sha).toBe(sha);
  });

  it('returns undefined when dropping the SHA leaves nothing else behind', async () => {
    const { run } = fakeRun(JSON.stringify({ commit_sha: sha }));
    expect(await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty: dirty })).toBeUndefined();
  });

  it('does NOT run the dirty check when the resolver produced no commit_sha', async () => {
    const checkDirty = vi.fn(clean);
    const { run } = fakeRun(JSON.stringify({ branch: 'main' }));
    const vcs = await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty });
    expect(vcs).toEqual({ branch: 'main' });
    expect(checkDirty).not.toHaveBeenCalled();
  });

  it('survives a dirty checker that THROWS, treating it as unknown', async () => {
    const { run } = full();
    const checkDirty = async (): Promise<boolean> => {
      throw new Error('git exploded');
    };
    const vcs = await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty });
    expect(vcs?.commit_sha).toBe(sha);
  });
});

describe('resolveVcsMetadata — the explicit commit override', () => {
  const sha = 'a'.repeat(40);
  const override = 'e'.repeat(40);

  it('REPLACES the resolved commit_sha with the explicit one', async () => {
    const { run } = fakeRun(JSON.stringify({ provider: 'github', commit_sha: sha, branch: 'x' }));
    const vcs = await resolveVcsMetadata({
      projectRoot: '/p',
      commit: override,
      run,
      checkDirty: clean,
    });
    expect(vcs).toEqual({ provider: 'github', commit_sha: override, branch: 'x' });
  });

  it('yields a commit-only object when the resolver found nothing', async () => {
    const { run } = fakeRun('{}');
    const vcs = await resolveVcsMetadata({
      projectRoot: '/p',
      commit: override,
      run,
      checkDirty: clean,
    });
    expect(vcs).toEqual({ commit_sha: override });
  });

  it('SKIPS the dirty gate — the caller asserted this SHA deliberately', async () => {
    const { run } = fakeRun(JSON.stringify({ commit_sha: sha }));
    const checkDirty = vi.fn(dirty);
    const vcs = await resolveVcsMetadata({
      projectRoot: '/p',
      commit: override,
      run,
      checkDirty,
    });
    expect(vcs).toEqual({ commit_sha: override });
    expect(checkDirty).not.toHaveBeenCalled();
  });

  it('reads BUGSEE_BUILD_COMMIT from the supplied env', async () => {
    const { run } = fakeRun('{}');
    const vcs = await resolveVcsMetadata({
      projectRoot: '/p',
      env: { BUGSEE_BUILD_COMMIT: override },
      run,
      checkDirty: clean,
    });
    expect(vcs).toEqual({ commit_sha: override });
  });

  it('IGNORES an invalid override and still uses the resolver (with its dirty gate)', async () => {
    const { run } = fakeRun(JSON.stringify({ commit_sha: sha }));
    const checkDirty = vi.fn(clean);
    const vcs = await resolveVcsMetadata({
      projectRoot: '/p',
      commit: 'not-a-sha',
      run,
      checkDirty,
    });
    expect(vcs).toEqual({ commit_sha: sha });
    expect(checkDirty).toHaveBeenCalledTimes(1);
  });

  it('still spawns the resolver for the OTHER fields (branch/repo/provider) when overridden', async () => {
    const { run, calls } = fakeRun(JSON.stringify({ provider: 'gitlab', repo: 'g/p' }));
    const vcs = await resolveVcsMetadata({
      projectRoot: '/p',
      commit: override,
      run,
      checkDirty: clean,
    });
    expect(calls).toHaveLength(1);
    expect(vcs).toEqual({ provider: 'gitlab', repo: 'g/p', commit_sha: override });
  });
});

describe('isWorkingTreeDirty', () => {
  const fakeSpawn =
    (result: SpawnResult | Error): SpawnFn =>
    async () => {
      if (result instanceof Error) {
        throw result;
      }
      return result;
    };

  it('reports CLEAN on exit 0', async () => {
    expect(await isWorkingTreeDirty('/p', fakeSpawn({ code: 0, stdout: '', stderr: '' }))).toBe(
      false,
    );
  });

  it('reports DIRTY on exit 1 — git diff --quiet signals a difference with exit 1', async () => {
    expect(await isWorkingTreeDirty('/p', fakeSpawn({ code: 1, stdout: '', stderr: '' }))).toBe(
      true,
    );
  });

  it('reports UNKNOWN on exit 128 (not a repository / no commits yet)', async () => {
    expect(
      await isWorkingTreeDirty('/p', fakeSpawn({ code: 128, stdout: '', stderr: '' })),
    ).toBeUndefined();
  });

  it('reports UNKNOWN when git is absent (spawn rejects)', async () => {
    expect(
      await isWorkingTreeDirty('/p', fakeSpawn(new Error('spawn git ENOENT'))),
    ).toBeUndefined();
  });

  it('reports UNKNOWN when the child was killed by a signal (code -1)', async () => {
    expect(
      await isWorkingTreeDirty('/p', fakeSpawn({ code: -1, stdout: '', stderr: '' })),
    ).toBeUndefined();
  });

  it('runs `git diff --quiet HEAD --` in the given directory, and never through a shell', async () => {
    const calls: { command: string; args: string[]; options: { cwd?: string } }[] = [];
    const spawn: SpawnFn = async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '', stderr: '' };
    };
    await isWorkingTreeDirty('/proj', spawn);
    expect(calls[0]?.command).toBe('git');
    // `HEAD` compares index+worktree against the commit, so a STAGED-only change counts as dirty;
    // the trailing `--` disambiguates paths. Untracked files are deliberately NOT dirt.
    expect(calls[0]?.args).toEqual(['diff', '--quiet', 'HEAD', '--']);
    expect(calls[0]?.options.cwd).toBe('/proj');
  });

  it('reports UNKNOWN rather than hanging when git never returns', async () => {
    const spawn: SpawnFn = () => new Promise<SpawnResult>(() => {});
    expect(await isWorkingTreeDirty('/p', spawn, 5)).toBeUndefined();
  });
});

// The real `git`, in real repositories — the semantics above are ASSERTIONS ABOUT GIT, and a stub
// cannot falsify them. Each case is one the brief requires to degrade gracefully.
describe('isWorkingTreeDirty — against the real git binary', () => {
  const makeRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-vcs-'));
    return dir;
  };

  it('is UNKNOWN outside a git repository, and correct for clean/dirty/untracked inside one', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = makeRepo();
    try {
      // Outside a repo. (mkdtemp lands in the OS temp dir, which is not inside this checkout.)
      expect(await isWorkingTreeDirty(dir)).toBeUndefined();

      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
      };
      git('init', '-q', '.');
      // A repo with NO commits: `HEAD` does not resolve → unknown, not a crash.
      expect(await isWorkingTreeDirty(dir)).toBeUndefined();

      writeFileSync(join(dir, 'a.txt'), 'hello\n');
      git('add', '.');
      git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
      expect(await isWorkingTreeDirty(dir)).toBe(false);

      // A MODIFIED tracked file is what makes a SHA lie about the built source.
      writeFileSync(join(dir, 'a.txt'), 'hello\nmodified\n');
      expect(await isWorkingTreeDirty(dir)).toBe(true);

      git('checkout', '--', 'a.txt');
      expect(await isWorkingTreeDirty(dir)).toBe(false);

      // An UNTRACKED file is not dirt: nothing committed changed, so every fetched source line
      // still matches. Treating it as dirt would disable the feature on most working checkouts.
      writeFileSync(join(dir, 'new.txt'), 'x\n');
      expect(await isWorkingTreeDirty(dir)).toBe(false);

      // A detached HEAD (every CI checkout) is clean and resolvable.
      git('checkout', '-q', '--detach', 'HEAD');
      expect(await isWorkingTreeDirty(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The DEFAULT seams — the arms a real build actually takes. Injecting every dependency in every test
// leaves the production wiring itself unexercised, which is how a default that points at the wrong
// thing survives a green suite.
describe('resolveVcsMetadata — production defaults, not injected', () => {
  it('reads BUGSEE_BUILD_COMMIT from process.env when no env is supplied', async () => {
    const sha = '9'.repeat(40);
    const previous = process.env.BUGSEE_BUILD_COMMIT;
    process.env.BUGSEE_BUILD_COMMIT = sha;
    try {
      const { run } = fakeRun('{}');
      expect(await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty: clean })).toEqual({
        commit_sha: sha,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.BUGSEE_BUILD_COMMIT;
      } else {
        process.env.BUGSEE_BUILD_COMMIT = previous;
      }
    }
  });

  it('uses the REAL dirtiness probe when none is injected — a non-repo directory is "unknown", so the SHA survives', async () => {
    const sha = '7'.repeat(40);
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-vcs-default-'));
    try {
      const { run } = fakeRun(JSON.stringify({ commit_sha: sha }));
      // No `checkDirty`: this exercises `isWorkingTreeDirty` against a real, git-less directory.
      const vcs = await resolveVcsMetadata({ projectRoot: dir, run });
      expect(vcs).toEqual({ commit_sha: sha });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
