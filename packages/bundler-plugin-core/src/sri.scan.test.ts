// The HTML scan must be linear and bounded on hostile input, and must find exactly what the regexes it replaced
// found on ordinary input.
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findSriProtectedScripts,
  findSriProtectedScriptsDetailed,
  findTags,
  MAX_HTML_BYTES,
  stripComments,
} from './sri';

const made: string[] = [];
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugsee-sri-scan-'));
  made.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// The implementations this replaced, kept as the reference the new scanners must agree with.
const SCRIPT_TAG = /<script\b[^>]*>/gi;
const PRELOAD_TAG = /<link\b[^>]*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

it('MAX_HTML_BYTES is 8 MiB', () => {
  expect(MAX_HTML_BYTES).toBe(8 * 1024 * 1024);
});

describe('findTags / stripComments agree with the regexes they replaced', () => {
  const pieces = [
    '<script',
    '<SCRIPT',
    '<Script ',
    ' src="a.js"',
    ' integrity="sha384-x"',
    '>',
    '</script>',
    '<!--',
    '-->',
    '<!-->',
    '<link rel="modulepreload" href="b.js">',
    '<link',
    '<scripts>',
    '<linkage>',
    '<script/>',
    '<script\t',
    '\n',
    ' ',
    'text',
    '<',
    '<p>',
    '<script>',
  ];
  it('on thousands of random concatenations of tag-ish fragments', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 4000; round++) {
      let text = '';
      for (let i = 0, n = next() % 14; i < n; i++) {
        text += pieces[next() % pieces.length];
      }
      expect(stripComments(text), JSON.stringify(text)).toBe(text.replace(HTML_COMMENT, ''));
      const markup = text.replace(HTML_COMMENT, '');
      expect(findTags(markup, 'script'), JSON.stringify(text)).toEqual(
        markup.match(SCRIPT_TAG) ?? [],
      );
      expect(findTags(markup, 'link'), JSON.stringify(text)).toEqual(
        markup.match(PRELOAD_TAG) ?? [],
      );
    }
  });

  it('a name followed by a non-word character is a tag; a longer name is not', () => {
    expect(findTags('<script>', 'script')).toEqual(['<script>']);
    expect(findTags('<script src=a>', 'script')).toEqual(['<script src=a>']);
    expect(findTags('<scripts>', 'script')).toEqual([]);
    expect(findTags('<script_x>', 'script')).toEqual([]);
    expect(findTags('<SCRIPT\nsrc=a>', 'script')).toEqual(['<SCRIPT\nsrc=a>']);
    expect(findTags('<script', 'script')).toEqual([]);
  });
});

describe('pathological input stays linear', () => {
  const FAST_MS = 2_000;

  it('400 KB of unterminated `<script `, `<link ` and `<!--` is scanned in well under the old seconds', () => {
    for (const unit of ['<script ', '<link ', '<!--', '<!-- <script ', '<script <!-- ']) {
      const text = unit.repeat(Math.ceil(400_000 / unit.length));
      const started = Date.now();
      stripComments(text);
      findTags(stripComments(text), 'script');
      findTags(stripComments(text), 'link');
      expect(Date.now() - started, unit).toBeLessThan(FAST_MS);
    }
  });

  it('many tags each closed, and many comments each closed, are linear too', () => {
    const text = '<!-- c --><script src="a.js" integrity="sha384-x"></script>'.repeat(20_000);
    const started = Date.now();
    expect(findTags(stripComments(text), 'script')).toHaveLength(20_000);
    expect(Date.now() - started).toBeLessThan(FAST_MS);
  });

  it('end to end: a page of unterminated repeats is scanned fast and finds nothing', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'index.html'), '<script '.repeat(100_000));
    const started = Date.now();
    expect(await findSriProtectedScripts(dir)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(FAST_MS);
  });
});

describe('page size is bounded', () => {
  it('a page larger than MAX_HTML_BYTES is skipped and reported, not read', async () => {
    const dir = await fixture();
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'ok.html'), '<script src="a.js" integrity="sha384-x"></script>');
    await writeFile(join(dir, 'sub', 'huge.html'), '');
    await truncate(join(dir, 'sub', 'huge.html'), MAX_HTML_BYTES + 1);
    const scan = await findSriProtectedScriptsDetailed(dir);
    expect(scan.scripts.map((s) => s.script)).toEqual([join(dir, 'a.js')]);
    expect(scan.skippedPages).toEqual([
      { html: join(dir, 'sub', 'huge.html'), size: MAX_HTML_BYTES + 1 },
    ]);
  });

  it('the stamp guard (findSriProtectedScripts) still sees a pin in a page over the doctor cap', async () => {
    const dir = await fixture();
    const tag = '<script src="a.js" integrity="sha384-x"></script>';
    await writeFile(join(dir, 'big.html'), tag + ' '.repeat(MAX_HTML_BYTES + 10));
    expect((await findSriProtectedScripts(dir)).map((s) => s.script)).toEqual([join(dir, 'a.js')]);
  });

  it('a page of exactly MAX_HTML_BYTES is scanned', async () => {
    const dir = await fixture();
    const tag = '<script src="a.js" integrity="sha384-x"></script>';
    await writeFile(join(dir, 'p.html'), tag + ' '.repeat(MAX_HTML_BYTES - tag.length));
    const scan = await findSriProtectedScriptsDetailed(dir);
    expect(scan.skippedPages).toEqual([]);
    expect(scan.scripts).toHaveLength(1);
  });
});
