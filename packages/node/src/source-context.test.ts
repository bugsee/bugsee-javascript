import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
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
