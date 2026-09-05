import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createSourceContextEnricher, isReadablePath, readContext } from './source-context';

const SOURCE = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n');

describe('readContext', () => {
  it('returns the throwing line with a window either side', () => {
    expect(readContext(SOURCE, 4, 2, 200)).toEqual({
      pre: ['b', 'c'],
      line: 'd',
      post: ['e', 'f'],
    });
  });

  it('omits `pre` at the top of a file rather than sending an empty array', () => {
    // Empty says "we looked and there was nothing", which is not the same as "there is no line 0".
    const context = readContext(SOURCE, 1, 3, 200);
    expect(context).not.toHaveProperty('pre');
    expect(context?.line).toBe('a');
  });

  it('omits `post` at the end of a file', () => {
    expect(readContext(SOURCE, 7, 3, 200)).not.toHaveProperty('post');
  });

  it('returns UNDEFINED when the line is not in the file', () => {
    // The normal outcome for a stack that has been through a build. Reporting the wrong lines with
    // confidence is worse than reporting none — a reader would debug the wrong code.
    expect(readContext(SOURCE, 99, 2, 200)).toBeUndefined();
    expect(readContext(SOURCE, 0, 2, 200)).toBeUndefined();
  });

  it('truncates a very long line — a minified bundle is one enormous one', () => {
    const context = readContext(`short\n${'x'.repeat(5000)}\nshort`, 2, 1, 20);
    expect(context?.line).toBe(`${'x'.repeat(20)}…`);
    expect(context?.pre).toEqual(['short']); // the window is clipped too, not just the line
  });
});

describe('readContext — secrets in the source window', () => {
  // The defect this closes: these lines shipped verbatim, so a hardcoded credential ON or NEAR the
  // throwing line was disclosed in plaintext — while the same value held in a local variable arrived
  // as `<redacted>`, because local-variable capture scrubs by key name. The rule itself lives in
  // `@bugsee/protocol` (`redactSourceLines`), shared with the worker; these pin the WIRING.
  const secretSource = [
    'const before = 1;',
    'const apiKey = "sk-live-SUPERSECRET";',
    'throw new Error("boom");',
    "const password = 'hunter2';",
    'const after = 2;',
  ].join('\n');

  it('redacts a secret on the THROWING line', () => {
    expect(readContext(`const apiKey = "sk-live-SUPERSECRET";`, 1, 0, 200)?.line).toBe(
      'const apiKey = "<redacted>";',
    );
  });

  it('redacts secrets in `pre` and `post`, not only on the throwing line', () => {
    const context = readContext(secretSource, 3, 2, 200);
    expect(context?.pre).toEqual(['const before = 1;', 'const apiKey = "<redacted>";']);
    expect(context?.post).toEqual(["const password = '<redacted>';", 'const after = 2;']);
  });

  it('leaves ordinary source alone', () => {
    expect(readContext(secretSource, 5, 0, 200)?.line).toBe('const after = 2;');
  });

  it('redacts BEFORE clipping, so a clipped line cannot ship a secret prefix', () => {
    // Clipping first would cut the literal in half: no closing quote for the assignment pass to match,
    // no complete shape for the shape pass, and a usable prefix of the credential on the wire.
    const padding = 'x'.repeat(40);
    const line = `const apiKey = "sk-live-${padding}"; // ${padding}`;
    const context = readContext(line, 1, 0, 30);
    expect(context?.line).toBe('const apiKey = "<redacted>"; /…');
    expect(context?.line).not.toContain('sk-live');
  });

  it('keeps the window aligned when a redacted literal spans lines', () => {
    // A multi-line template collapsed to one `<redacted>` would shorten the window and slide every
    // later line onto the wrong position — a frame pointing at source it did not throw from.
    const source = [
      'const secret = `a',
      'b',
      'c`;',
      'throw new Error("boom");',
      'const tail = 1;',
    ].join('\n');
    const context = readContext(source, 4, 3, 200);
    expect(context?.line).toBe('throw new Error("boom");');
    expect(context?.pre).toHaveLength(3);
    expect(context?.post).toEqual(['const tail = 1;']);
    expect(context?.pre?.join('\n')).not.toContain('b');
  });
});

describe('isReadablePath', () => {
  it.each([
    ['/app/src/index.js', true],
    ['C:\\app\\src\\index.js', true],
    ['node_modules/express/lib/router/index.js', false], // scrubbed dependency frame
    ['https://app.test/static/main.js', false],
    ['./src/app.ts', true], // relative NOW resolves — app frames are scrubbed to this shape
    [undefined, false],
  ])('%s -> %s', (path, expected) => {
    expect(isReadablePath(path as string | undefined)).toBe(expected);
  });
});

describe('createSourceContextEnricher', () => {
  const frames = (file: string) => [{ file, line: 4, column: 1, function: 'f' }];

  it('attaches context for an application frame', () => {
    const enrich = createSourceContextEnricher({ readFile: () => SOURCE, contextLines: 1 });
    expect(enrich(new Error('x'), frames('/app/a.js'))[0]?.context).toEqual({
      pre: ['c'],
      line: 'd',
      post: ['e'],
    });
  });

  it('does NOT read a scrubbed dependency frame', () => {
    // It would not resolve, and reading a dependency's source is not something the SDK should do.
    const readFile = vi.fn(() => SOURCE);
    const enrich = createSourceContextEnricher({ readFile });
    expect(enrich(new Error('x'), frames('node_modules/express/index.js'))[0]).not.toHaveProperty(
      'context',
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it('returns the SAME array when nothing could be attached', () => {
    const enrich = createSourceContextEnricher({ readFile: () => undefined });
    const input = frames('/app/a.js');
    expect(enrich(new Error('x'), input)).toBe(input);
  });

  it('stops after maxFrames, and skips a frame with no line number', () => {
    const readFile = vi.fn(() => SOURCE);
    const enrich = createSourceContextEnricher({ readFile, maxFrames: 1 });
    const out = enrich(new Error('x'), [
      { file: '/app/a.js', line: 4 },
      { file: '/app/b.js', line: 4 },
      { file: '/app/c.js' },
    ]);
    expect(out[0]).toHaveProperty('context');
    expect(out[1]).not.toHaveProperty('context');
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('reads each file ONCE, including one that could not be read', () => {
    // Caching the failure matters as much as caching the hit: a file that cannot be read will not become
    // readable within a process, and retrying it per frame per crash is pure syscall churn.
    const readFile = vi.fn(() => undefined);
    const enrich = createSourceContextEnricher({ readFile });
    for (let i = 0; i < 3; i += 1) enrich(new Error('x'), frames('/app/missing.js'));
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('bounds the file cache', () => {
    const readFile = vi.fn(() => SOURCE);
    const enrich = createSourceContextEnricher({ readFile, maxCachedFiles: 2 });
    for (const f of ['/a.js', '/b.js', '/c.js', '/a.js']) enrich(new Error('x'), frames(f));
    expect(readFile).toHaveBeenCalledTimes(4); // '/a.js' was evicted and re-read
  });

  it('reports a throwing reader and leaves the frame alone', () => {
    const onError = vi.fn();
    const enrich = createSourceContextEnricher({
      onError,
      readFile: () => {
        throw new Error('EACCES');
      },
    });
    expect(enrich(new Error('x'), frames('/app/a.js'))[0]).not.toHaveProperty('context');
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('leaves the frame alone when the file was read but the LINE is not in it', () => {
    // The normal outcome for a stack that has been through a build: the file resolves, the line number
    // points past its end. Attaching whatever happens to be at that offset would point a reader at
    // unrelated code with full confidence.
    const enrich = createSourceContextEnricher({ readFile: () => 'one\ntwo' });
    const input = [{ file: '/app/a.js', line: 900 }];
    const out = enrich(new Error('x'), input);
    expect(out[0]).not.toHaveProperty('context');
    expect(out).toBe(input); // nothing changed, so nothing was copied
  });

  it('survives a throwing reader with NO onError supplied', () => {
    // The defaulted sink. Reading source is best-effort decoration on a crash report — it must never
    // become the reason the report fails.
    const enrich = createSourceContextEnricher({
      readFile: () => {
        throw new Error('EACCES');
      },
    });
    expect(() => enrich(new Error('x'), frames('/app/a.js'))).not.toThrow();
  });

  it('reads a REAL file from disk by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-ctx-'));
    const file = join(dir, 'real.js');
    writeFileSync(file, SOURCE);
    const enrich = createSourceContextEnricher({ contextLines: 1 });
    expect(enrich(new Error('x'), [{ file, line: 4 }])[0]?.context?.line).toBe('d');
  });

  it('returns the frame untouched when the real file does not exist', () => {
    const enrich = createSourceContextEnricher();
    expect(enrich(new Error('x'), frames('/definitely/not/here.js'))[0]).not.toHaveProperty(
      'context',
    );
  });
});

describe('source context after the frame paths became RELATIVE', () => {
  it('resolves a `./` frame against the app root', () => {
    // The interaction that broke it: application frames now ship `./src/app.js` (the privacy fix), and
    // this reader accepted only absolute paths — so context silently stopped working for exactly the
    // application files it exists for. Each feature was right alone and wrong together.
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-ctx-rel-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.js'), SOURCE);
    const enrich = createSourceContextEnricher({ appRoot: dir, contextLines: 1 });
    expect(enrich(new Error('x'), [{ file: './src/app.js', line: 4 }])[0]?.context?.line).toBe('d');
  });

  it('still reads an absolute path, which is what a frame outside the app root keeps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-ctx-abs-'));
    const file = join(dir, 'outside.js');
    writeFileSync(file, SOURCE);
    const enrich = createSourceContextEnricher({ appRoot: '/somewhere/else', contextLines: 1 });
    expect(enrich(new Error('x'), [{ file, line: 4 }])[0]?.context?.line).toBe('d');
  });

  it('treats a `./` path as readable now, but still not a bare dependency path', () => {
    expect(isReadablePath('./src/app.js')).toBe(true);
    expect(isReadablePath('node_modules/express/index.js')).toBe(false);
  });
});

describe('createSourceContextEnricher — a working directory that has been deleted', () => {
  it('still reads absolute frames when process.cwd() throws', () => {
    // `safeCwd` returns '' then. Source context is decoration on a crash report; it must never be the
    // reason a report fails, and an absolute frame needs no root anyway.
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-ctx-nocwd-'));
    const file = join(dir, 'a.js');
    writeFileSync(file, SOURCE);
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('ENOENT: uv_cwd');
    });
    try {
      const enrich = createSourceContextEnricher({ contextLines: 1 });
      expect(enrich(new Error('x'), [{ file, line: 4 }])[0]?.context?.line).toBe('d');
    } finally {
      cwd.mockRestore();
    }
  });
});

describe('the background worker vendors an equivalent copy of the redaction artifact', () => {
  // WHY HERE. `packages/protocol` owns `source-line-redaction.vectors.json` and runs its vectors, but
  // it compiles with no Node types (`types: []`) and so cannot open a file. This tier can, and it is
  // the SDK-side producer of the very windows the worker REPLACES on a remap — so the question "do the
  // two repos still agree?" is at home next to `readContext`.
  //
  // The one hand step left in the loop, so it gets a test rather than a comment. It can only run where
  // the worker checkout is present — a developer machine — so it SKIPS elsewhere rather than passing
  // silently, and says so. The behavioural half (the vectors) is enforced in BOTH CIs independently,
  // which is what stops a stale copy from being a silent divergence rather than merely an old one.
  //
  // CONTENT, not bytes: `pnpm lint:fix` reformats the canonical JSON (biome collapses the short
  // arrays), and a byte comparison duly went red on a re-format that changed no vector. A guard that
  // fires on whitespace gets suppressed, and then it is not a guard.
  const require_ = createRequire(import.meta.url);
  // Through the package's own `exports` map, so a rename that forgets to update it fails HERE rather
  // than leaving this test quietly reading a path that no consumer can reach.
  const canonical = JSON.parse(
    readFileSync(require_.resolve('@bugsee/protocol/source-line-redaction.vectors.json'), 'utf8'),
  );
  const workerRepo =
    process.env.BUGSEE_WORKER_REPO ??
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'worker');
  const vendored = join(workerRepo, 'symbolfiles', 'source_line_redaction.vectors.json');
  const present = existsSync(vendored);

  it('the canonical artifact is where this test thinks it is', () => {
    // Otherwise a moved or renamed file would make the comparison below vacuously pass.
    expect(canonical.vectors.length).toBeGreaterThan(25);
  });

  it.skipIf(!present)('carries the same definitions and vectors as the canonical file', () => {
    expect(JSON.parse(readFileSync(vendored, 'utf8'))).toEqual(canonical);
  });

  it.runIf(!present)('is not checkable here — recorded, not silently skipped', () => {
    expect(present).toBe(false);
  });
});
