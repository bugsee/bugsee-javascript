import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script (the refresh tool), no declaration file
import * as refresh from '../../../scripts/spec-snapshot/refresh.mjs';

// `pnpm spec:refresh` / `spec:check`: runs the real script against a throwaway git repo that stands in for bugsee/specs.

const { buildSnapshot, serialize, parseArgs, findSpecs, SPEC_PATH, SPEC_REPO, SNAPSHOT_PATH } =
  refresh as {
    buildSnapshot(md: string, source: object): { source: Record<string, string> };
    serialize(snapshot: object): string;
    parseArgs(argv: string[]): { check: boolean; ref: string; specs?: string; out: string };
    findSpecs(
      explicit?: string,
      deps?: {
        env?: Record<string, string | undefined>;
        roots?: string[];
        exists?: (p: string) => boolean;
      },
    ): string;
    SPEC_PATH: string;
    SPEC_REPO: string;
    SNAPSHOT_PATH: string;
  };

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'spec-snapshot',
  'refresh.mjs',
);

const SPEC_MD = (extra: string): string => `## Traces shared with mobile

| trace | value | runtimes | held | mobile | notes |
|---|---|---|---|---|---|
| \`battery\` | int 0–100, percent | browser | held | = | x |${extra}

## Browser family traces

| trace | value | held | source | notes |
|---|---|---|---|---|
| \`route\` | string | held | a | **[pending: C12]** |

## Node family traces

| trace | value | notes |
|---|---|---|
| \`process_memory_rss\` | int bytes | x |

## Electron main traces

| trace | value | held | notes |
|---|---|---|---|
| \`app_metrics\` | object | no | x |

## Events shared with mobile

| event | params | trigger | runtimes | mobile |
|---|---|---|---|---|
| \`DarkModeChanged\` | \`dark\` boolean | mq | browser | x |

## Browser family events

| event | params | trigger | notes |
|---|---|---|---|
| \`freeze\` | none | pl | |

## Node family events

| event | params | trigger | notes |
|---|---|---|---|
| \`gc\` | \`count\` int | obs | |

## Electron main events

| event | params | trigger | requires |
|---|---|---|---|
| \`power_ac\` | none | pm | \`powerMonitor\` |

## Retired names

| retired | replaced by |
|---|---|
| \`screen_size\` | displays |

## Mobile traces and events the JavaScript SDK does not emit

| mobile name | platform | why |
|---|---|---|
| \`wifi\` | both | none |
`;

let dir: string;
let specs: string;
let commit1: string;
let commit2: string;

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', specs, ...args], { encoding: 'utf8' }).trim();
const run = (...args: string[]) =>
  spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BUGSEE_SPECS: '' },
  });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'spec-refresh-'));
  specs = join(dir, 'specs');
  mkdirSync(join(specs, 'sdk', 'reporting', 'platforms'), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  const file = join(specs, SPEC_PATH);
  writeFileSync(file, SPEC_MD(''));
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  commit1 = git('rev-parse', 'HEAD');
  writeFileSync(file, SPEC_MD('\n| `charging` | object | browser | held | = | x |'));
  // author and committer dates differ: the snapshot records the COMMITTER date
  execFileSync('git', ['-C', specs, 'commit', '-qam', 'two', '--date', '2020-02-02T02:02:02Z'], {
    env: { ...process.env, GIT_COMMITTER_DATE: '2021-03-03T03:03:03Z' },
  });
  commit2 = git('rev-parse', 'HEAD');
  git('tag', '-a', 'v1', '-m', 'annotated', commit1); // an annotated tag: its own object id differs from the commit's
  // the working tree is on a different, dirty state: the tool must read the REF, not the files
  writeFileSync(file, 'garbage in the working tree');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('buildSnapshot / serialize', () => {
  it('prefixes the source (repo, path, then the given commit fields) and ends the file with a newline', () => {
    const snap = buildSnapshot(SPEC_MD(''), { commit: 'abc', committed: 'when' });
    expect(snap.source).toEqual({
      repo: SPEC_REPO,
      path: SPEC_PATH,
      commit: 'abc',
      committed: 'when',
    });
    expect(Object.keys(snap)).toEqual(['source', 'traces', 'events', 'retired', 'notEmitted']);
    const text = serialize(snap);
    expect(text).toBe(`${JSON.stringify(snap, null, 2)}\n`); // indented, newline-terminated
    expect(JSON.parse(text)).toEqual(snap);
  });

  it('vendors into the protocol package', () => {
    expect(SNAPSHOT_PATH.replaceAll('\\', '/')).toMatch(
      /packages\/protocol\/spec\/javascript-system-traces\.snapshot\.json$/,
    );
  });
});

describe('parseArgs', () => {
  it('defaults to origin/main, write mode and the vendored path', () => {
    expect(parseArgs([])).toEqual({
      check: false,
      ref: 'origin/main',
      specs: undefined,
      out: SNAPSHOT_PATH,
    });
  });

  it('reads every flag', () => {
    const a = parseArgs(['--check', '--specs', '/s', '--ref', 'v1', '--out', 'rel.json']);
    expect(a).toMatchObject({ check: true, specs: '/s', ref: 'v1' });
    expect(isAbsolute(a.out)).toBe(true);
    expect(a.out.endsWith('rel.json')).toBe(true);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument --nope/);
  });
});

describe('findSpecs', () => {
  it('accepts an explicit git checkout and refuses an explicit non-checkout without falling back', () => {
    expect(findSpecs(specs)).toBe(specs);
    expect(() => findSpecs(dir)).toThrow(/not a git checkout/);
  });
});

describe('findSpecs search order', () => {
  const only =
    (...dirs: string[]) =>
    (p: string) =>
      dirs.some((d) => p === join(d, '.git'));

  it('takes the explicit path, then $BUGSEE_SPECS, then the sibling roots, in that order', () => {
    const all = only('/a', '/b', '/c');
    expect(findSpecs('/a', { env: { BUGSEE_SPECS: '/b' }, roots: ['/c'], exists: all })).toBe('/a');
    expect(findSpecs(undefined, { env: { BUGSEE_SPECS: '/b' }, roots: ['/c'], exists: all })).toBe(
      '/b',
    );
    expect(findSpecs(undefined, { env: {}, roots: ['/x', '/c'], exists: all })).toBe('/c');
  });

  it('skips a candidate that is not a checkout and an empty $BUGSEE_SPECS', () => {
    expect(
      findSpecs(undefined, { env: { BUGSEE_SPECS: '/nope' }, roots: ['/c'], exists: only('/c') }),
    ).toBe('/c');
    const everything = () => true;
    expect(
      findSpecs(undefined, { env: { BUGSEE_SPECS: '' }, roots: ['/c'], exists: everything }),
    ).toBe('/c');
  });

  it('throws when nothing is found', () => {
    expect(() => findSpecs(undefined, { env: {}, roots: ['/x'], exists: () => false })).toThrow(
      /no bugsee\/specs checkout found/,
    );
  });
});

describe('the refresh command', () => {
  it('writes the snapshot of the ref (not of the working tree) with its commit', () => {
    const out = join(dir, 'out.json');
    const r = run('--specs', specs, '--ref', 'main', '--out', out);
    expect(r.status).toBe(0);
    const snap = JSON.parse(readFileSync(out, 'utf8'));
    expect(snap.source.commit).toBe(commit2);
    expect(snap.source.committed).toBe(git('show', '-s', '--format=%cI', commit2));
    expect(snap.traces.map((t: { name: string }) => t.name)).toContain('charging');
    expect(snap.retired).toEqual(['screen_size']);
    expect(r.stdout).toContain(commit2.slice(0, 12));
  });

  it('can target an older commit', () => {
    const out = join(dir, 'old.json');
    expect(run('--specs', specs, '--ref', commit1, '--out', out).status).toBe(0);
    const snap = JSON.parse(readFileSync(out, 'utf8'));
    expect(snap.source.commit).toBe(commit1);
    expect(snap.traces.map((t: { name: string }) => t.name)).not.toContain('charging');
  });

  it('records the committer date and resolves an annotated tag to its commit, not to the tag object', () => {
    const out = join(dir, 'tag.json');
    expect(run('--specs', specs, '--ref', 'main', '--out', out).status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).source.committed).toBe('2021-03-03T03:03:03Z');
    expect(run('--specs', specs, '--ref', 'v1', '--out', out).status).toBe(0);
    const snap = JSON.parse(readFileSync(out, 'utf8'));
    expect(git('rev-parse', 'v1')).not.toBe(commit1);
    expect(snap.source.commit).toBe(commit1);
  });

  it('--check passes on a fresh snapshot and fails on a stale or missing one', () => {
    const out = join(dir, 'check.json');
    expect(run('--check', '--specs', specs, '--ref', 'main', '--out', out).status).toBe(1); // missing
    run('--specs', specs, '--ref', commit1, '--out', out);
    const stale = run('--check', '--specs', specs, '--ref', 'main', '--out', out);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('out of date');
    run('--specs', specs, '--ref', 'main', '--out', out);
    const fresh = run('--check', '--specs', specs, '--ref', 'main', '--out', out);
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toContain('snapshot matches');
  });

  it('fails without a checkout and on an unknown ref', () => {
    expect(run('--specs', dir).status).not.toBe(0);
    expect(
      run('--specs', specs, '--ref', 'no-such-ref', '--out', join(dir, 'x.json')).status,
    ).not.toBe(0);
  });
});
