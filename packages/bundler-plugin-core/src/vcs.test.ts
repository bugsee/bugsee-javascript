import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SpawnFn, SpawnResult } from './run-cli';
import {
  DIRTY_TIMEOUT_MS,
  isWorkingTreeDirty,
  resolveCommitOverride,
  resolveVcsMetadata,
  VCS_TIMEOUT_MS,
} from './vcs';

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

/** A dirty-checker stub that RECORDS the directory it was asked about. */
function dirtStub(answer: boolean | undefined): {
  probe: (dir: string) => Promise<boolean | undefined>;
  dirs: string[];
} {
  const dirs: string[] = [];
  return {
    dirs,
    probe: async (dir) => {
      dirs.push(dir);
      return answer;
    },
  };
}

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

  it('REJECTS a hex run that is merely SUFFIXED onto junk — the anchor is load-bearing', () => {
    // Without the leading `^` these all match (each ENDS in >=7 hex chars) and are returned WHOLE, since
    // the function returns the trimmed input rather than the match. The appserver would then discard
    // them silently — which is exactly the outcome this guard exists to turn into a visible one.
    expect(resolveCommitOverride('refs/heads/abc1234', {})).toBeUndefined();
    expect(resolveCommitOverride('zz1234567', {})).toBeUndefined();
    expect(resolveCommitOverride(`origin/${'a'.repeat(40)}`, {})).toBeUndefined();
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

  it('passes EXACTLY the short probe budget, and no app token — this is a local read, not an upload', async () => {
    const { run, calls } = fakeRun('{}');
    await resolveVcsMetadata({ projectRoot: '/proj', run, checkDirty: clean });
    // The whole options bag, exactly. A range assertion here let a `timeoutMs: 1` mutation survive, and
    // asserting only `timeoutMs` let the absence of a token (vcs-metadata does no network I/O) go
    // unstated even though the implementation comment claims it.
    expect(calls[0]?.options).toEqual({ cwd: '/proj', timeoutMs: VCS_TIMEOUT_MS });
    expect(VCS_TIMEOUT_MS).toBe(15_000);
    // Far below the 120 s upload budget: a build must not hang on a git probe.
    expect(VCS_TIMEOUT_MS).toBeLessThan(120_000);
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

  // The two shapes where the object guard actually CHANGES the answer. Both fixtures are non-empty on
  // purpose: `{...[]}` and `{...''}` are `{}`, so an empty one is indistinguishable from a correct
  // rejection and lets an "arrays are objects too" mutation survive the whole suite.
  it.each([
    ['an array', '["a","b"]', '{0:"a",1:"b"}'],
    ['a string', '"abc"', '{0:"a",1:"b",2:"c"}'],
  ])('returns undefined when stdout parses to %s — which would otherwise spread to %s', async (_label, stdout) => {
    const { run } = fakeRun(stdout);
    expect(await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty: clean })).toBeUndefined();
  });

  // REGRESSION FIXTURES, not discriminators — stated plainly rather than dressed up as coverage.
  // `{...null}`, `{...42}` and `{...true}` are all `{}`, so the emptiness check would swallow these even
  // with the guard removed. They are pinned so a future refactor that makes them observable is noticed.
  it.each([
    ['null', 'null'],
    ['a number', '42'],
    ['a boolean', 'true'],
  ])('returns undefined for %s (via the guard or the emptiness check)', async (_label, stdout) => {
    const { run } = fakeRun(stdout);
    expect(await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty: clean })).toBeUndefined();
  });

  it('SAYS SO when the configured commit is malformed, rather than dropping it in silence', async () => {
    const notices: string[] = [];
    const { run } = fakeRun('{}');
    await resolveVcsMetadata({
      projectRoot: '/p',
      commit: 'refs/heads/main',
      run,
      checkDirty: clean,
      onNotice: (m) => notices.push(m),
    });
    expect(notices).toHaveLength(1);
    // The value the user actually typed has to appear, or they cannot tell WHICH setting is wrong.
    expect(notices[0]).toContain('refs/heads/main');
    expect(notices[0]).toContain('7-64 hex');
  });

  it.each([
    ['an EMPTY env var', ''],
    ['a whitespace-only env var', '   '],
  ])('says nothing for %s — an unset CI variable templates to exactly this', async (_l, value) => {
    const notices: string[] = [];
    const { run } = fakeRun('{}');
    await resolveVcsMetadata({
      projectRoot: '/p',
      env: { BUGSEE_BUILD_COMMIT: value },
      run,
      checkDirty: clean,
      onNotice: (m) => notices.push(m),
    });
    expect(notices).toEqual([]);
  });

  it('SURVIVES an onNotice sink that throws, keeping the metadata it had', async () => {
    // "never throws" is an absolute contract on public API. Losing the whole object — branch, repo,
    // provider — because a host's logger blew up would be a far worse trade than losing one message.
    const { run } = fakeRun(JSON.stringify({ commit_sha: 'a'.repeat(40), branch: 'main' }));
    const vcs = await resolveVcsMetadata({
      projectRoot: '/p',
      run,
      checkDirty: dirty,
      onNotice: () => {
        throw new Error('logger exploded');
      },
    });
    expect(vcs).toEqual({ branch: 'main' });
  });

  it('says nothing when no commit was configured at all — absence is not an error', async () => {
    const notices: string[] = [];
    const { run } = fakeRun('{}');
    await resolveVcsMetadata({
      projectRoot: '/p',
      run,
      checkDirty: clean,
      onNotice: (m) => notices.push(m),
    });
    expect(notices).toEqual([]);
  });

  it('says nothing when the configured commit is VALID', async () => {
    const notices: string[] = [];
    const { run } = fakeRun('{}');
    await resolveVcsMetadata({
      projectRoot: '/p',
      commit: 'a'.repeat(40),
      run,
      checkDirty: clean,
      onNotice: (m) => notices.push(m),
    });
    expect(notices).toEqual([]);
  });

  it('SAYS SO when a dirty tree cost the build its commit, and names the escape hatch', async () => {
    const notices: string[] = [];
    const { run } = fakeRun(JSON.stringify({ commit_sha: 'a'.repeat(40), branch: 'main' }));
    await resolveVcsMetadata({
      projectRoot: '/p',
      run,
      checkDirty: dirty,
      onNotice: (m) => notices.push(m),
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('allowDirtyCommit');
  });

  it('says nothing about dirtiness on a CLEAN tree', async () => {
    const notices: string[] = [];
    const { run } = fakeRun(JSON.stringify({ commit_sha: 'a'.repeat(40) }));
    await resolveVcsMetadata({
      projectRoot: '/p',
      run,
      checkDirty: clean,
      onNotice: (m) => notices.push(m),
    });
    expect(notices).toEqual([]);
  });

  it('says NOTHING about a malformed commit when disabled — it has no fallback to promise', async () => {
    // The notice's tail is "Falling back to the detected commit, if any." With detection off there is
    // no detection, so emitting it here would be a promise this path cannot keep.
    const notices: string[] = [];
    const run = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));
    expect(
      await resolveVcsMetadata({
        projectRoot: '/p',
        enabled: false,
        commit: 'HEAD',
        run,
        onNotice: (m) => notices.push(m),
      }),
    ).toBeUndefined();
    expect(notices).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('records NOTHING when disabled, even with a valid explicit commit — off means off', async () => {
    // ONE meaning for the option, matching what the plugin layer does (resolve.test.ts). An earlier
    // version honoured the commit here while the plugin layer discarded it, and a green test pinned
    // each of the two contradictory answers.
    const run = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));
    expect(
      await resolveVcsMetadata({
        projectRoot: '/p',
        enabled: false,
        commit: 'e'.repeat(40),
        run,
      }),
    ).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
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

  it('probes the CONFIGURED project root, not the process cwd', async () => {
    // A monorepo package built from the repo root has a projectRoot that differs from `process.cwd()`;
    // probing the wrong one silently returns the wrong dirtiness answer for the whole build.
    const { probe, dirs } = dirtStub(false);
    const { run } = full();
    await resolveVcsMetadata({ projectRoot: '/repo/packages/app', run, checkDirty: probe });
    expect(dirs).toEqual(['/repo/packages/app']);
    expect(dirs[0]).not.toBe(process.cwd());
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

  it('runs `git diff --quiet HEAD --` in the given directory, under an abort signal', async () => {
    const calls: {
      command: string;
      args: string[];
      options: { cwd?: string; signal?: AbortSignal };
    }[] = [];
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
    // The timeout only stops US waiting; the SIGNAL is what kills the child. Without it a hung `git`
    // is orphaned holding the build's handles, and the timeout test alone cannot see that.
    expect(calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.options.signal?.aborted).toBe(false);
  });

  it('ABORTS the child when the probe times out', async () => {
    let seen: AbortSignal | undefined;
    const spawn: SpawnFn = (_c, _a, options) => {
      seen = options.signal;
      return new Promise<SpawnResult>(() => {});
    };
    expect(await isWorkingTreeDirty('/p', spawn, 5)).toBeUndefined();
    expect(seen?.aborted).toBe(true);
  });

  it('uses a bounded default budget', () => {
    expect(DIRTY_TIMEOUT_MS).toBe(10_000);
    expect(DIRTY_TIMEOUT_MS).toBeLessThan(VCS_TIMEOUT_MS);
  });

  it('reports UNKNOWN rather than hanging when git never returns', async () => {
    const spawn: SpawnFn = () => new Promise<SpawnResult>(() => {});
    expect(await isWorkingTreeDirty('/p', spawn, 5)).toBeUndefined();
  });
});

// The real `git`, in real repositories — the semantics above are ASSERTIONS ABOUT GIT, and a stub cannot
// falsify them. Each case is one the brief requires to degrade gracefully.
//
// Hermeticity: every `git` call is insulated from the developer's global config. `commit.gpgsign=true` is
// a common global setting and would make `git commit` throw here, failing the suite for a reason that has
// nothing to do with this code.
describe('isWorkingTreeDirty — against the real git binary', () => {
  const made: string[] = [];

  afterAll(() => {
    for (const dir of made) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A scratch directory. NOT a repository — `initRepo` makes it one. */
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-vcs-'));
    made.push(dir);
    return dir;
  };

  const git = (dir: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  };

  /** A repository with exactly one commit of `a.txt`. */
  const initRepo = (): string => {
    const dir = scratch();
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    git(dir, 'init', '-q', '-b', 'main', '.');
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    return dir;
  };

  it('is UNKNOWN outside a git repository', async () => {
    // mkdtemp lands in the OS temp dir. If TMPDIR were pointed inside a checkout this would be a repo,
    // so the precondition is asserted rather than assumed.
    const dir = scratch();
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(await isWorkingTreeDirty(dir)).toBeUndefined();
  });

  it('is UNKNOWN in a repository with no commits — HEAD does not resolve', async () => {
    const dir = scratch();
    git(dir, 'init', '-q', '.');
    expect(await isWorkingTreeDirty(dir)).toBeUndefined();
  });

  it('is CLEAN on an untouched checkout', async () => {
    expect(await isWorkingTreeDirty(initRepo())).toBe(false);
  });

  it('is DIRTY for a modified tracked file — the case that makes a SHA lie about the built source', async () => {
    const dir = initRepo();
    writeFileSync(join(dir, 'a.txt'), 'hello\nmodified\n');
    expect(await isWorkingTreeDirty(dir)).toBe(true);
    git(dir, 'checkout', '--', 'a.txt');
    expect(await isWorkingTreeDirty(dir)).toBe(false); // …and it recovers
  });

  it('is DIRTY for a STAGED-but-uncommitted change', async () => {
    const dir = initRepo();
    writeFileSync(join(dir, 'a.txt'), 'staged\n');
    git(dir, 'add', 'a.txt');
    expect(await isWorkingTreeDirty(dir)).toBe(true);
  });

  it('is CLEAN with only UNTRACKED files', async () => {
    // Untracked files change nothing about any committed file, so every fetched source line still
    // matches. Counting them would disable the feature on most working checkouts.
    const dir = initRepo();
    writeFileSync(join(dir, 'new.txt'), 'x\n');
    expect(await isWorkingTreeDirty(dir)).toBe(false);
  });

  it('is CLEAN on a DETACHED HEAD — the shape of every CI checkout', async () => {
    const dir = initRepo();
    git(dir, 'checkout', '-q', '--detach', 'HEAD');
    expect(await isWorkingTreeDirty(dir)).toBe(false);
  });

  it('is CLEAN after mtimes are rewritten — a fresh checkout must not read as dirty', async () => {
    // `git diff --quiet` is famously stat-sensitive when the index is stale, and a CI checkout or a
    // restored build cache rewrites every mtime. If that read as dirty, the SHA would be dropped on
    // every CI build — killing the feature exactly where it matters most. Measured, not assumed:
    // porcelain `git diff` refreshes the index first (the plumbing `diff-index` is the one that
    // needs an explicit `update-index --refresh`), so both of these are clean.
    const dir = initRepo();
    const now = new Date();
    utimesSync(join(dir, 'a.txt'), now, now);
    expect(await isWorkingTreeDirty(dir)).toBe(false);

    // Harsher: same bytes, but a new inode and ctime as well as mtime.
    const bytes = readFileSync(join(dir, 'a.txt'));
    rmSync(join(dir, 'a.txt'));
    writeFileSync(join(dir, 'a.txt'), bytes);
    expect(await isWorkingTreeDirty(dir)).toBe(false);
  });

  it('is CLEAN in a SHALLOW clone — depth-1 CI checkouts must not read as dirty', async () => {
    const source = initRepo();
    const dir = scratch();
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${source}`, dir], {
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    // Precondition: this really is a truncated history, not a full clone.
    expect(
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: dir }).toString().trim(),
    ).toBe('true');
    expect(await isWorkingTreeDirty(dir)).toBe(false);
  });
});

// The DEFAULT seams — the arms a real build actually takes, driven by real git. Injecting every
// dependency in every test leaves the production wiring unexercised, which is how a default bound to the
// wrong function (`?? (async () => false)`, disabling the gate entirely) survives a green suite.
describe('resolveVcsMetadata — the dirty gate through its REAL probe', () => {
  const sha = '7'.repeat(40);
  const made: string[] = [];

  afterAll(() => {
    for (const dir of made) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const repo = (dirty: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-vcs-real-'));
    made.push(dir);
    const run = (...args: string[]): void => {
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        stdio: 'ignore',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    };
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    run('init', '-q', '-b', 'main', '.');
    run('add', '.');
    run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    if (dirty) {
      writeFileSync(join(dir, 'a.txt'), 'hello\nmodified\n');
    }
    return dir;
  };

  it('DROPS the SHA in a genuinely dirty repository, with NO probe injected', async () => {
    const { run } = fakeRun(JSON.stringify({ commit_sha: sha, branch: 'main' }));
    // No `checkDirty`: the real `isWorkingTreeDirty` must be what the default resolves to. Bind the
    // default to anything that answers "clean" and this returns the SHA.
    expect(await resolveVcsMetadata({ projectRoot: repo(true), run })).toEqual({ branch: 'main' });
  });

  it('KEEPS the SHA in a genuinely clean repository, with NO probe injected — the canary', async () => {
    const { run } = fakeRun(JSON.stringify({ commit_sha: sha, branch: 'main' }));
    expect(await resolveVcsMetadata({ projectRoot: repo(false), run })).toEqual({
      commit_sha: sha,
      branch: 'main',
    });
  });

  it('KEEPS the SHA outside a repository — "cannot tell" is not "dirty"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-vcs-nogit-'));
    made.push(dir);
    const { run } = fakeRun(JSON.stringify({ commit_sha: sha }));
    expect(await resolveVcsMetadata({ projectRoot: dir, run })).toEqual({ commit_sha: sha });
  });

  it('reads BUGSEE_BUILD_COMMIT from process.env when no env is supplied', async () => {
    const override = '9'.repeat(40);
    const previous = process.env.BUGSEE_BUILD_COMMIT;
    process.env.BUGSEE_BUILD_COMMIT = override;
    try {
      const { run } = fakeRun('{}');
      expect(await resolveVcsMetadata({ projectRoot: '/p', run, checkDirty: clean })).toEqual({
        commit_sha: override,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.BUGSEE_BUILD_COMMIT;
      } else {
        process.env.BUGSEE_BUILD_COMMIT = previous;
      }
    }
  });
});
