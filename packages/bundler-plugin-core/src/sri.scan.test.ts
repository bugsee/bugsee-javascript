// The HTML scan must be linear and bounded on hostile input, and must find exactly what the regexes it replaced
// found on ordinary input.
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
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

it('the detailed scan keeps every distinct pin of a script; the stamp wrapper one per script', async () => {
  const dir = await fixture();
  await writeFile(join(dir, 'a.html'), '<script src="a.js" integrity="sha384-AAA"></script>');
  await writeFile(join(dir, 'b.html'), '<script src="a.js" integrity="sha384-BBB"></script>');
  await writeFile(join(dir, 'c.html'), '<script src="a.js" integrity="sha384-AAA"></script>');
  const detailed = await findSriProtectedScriptsDetailed(dir);
  expect(detailed.scripts.map((s) => s.integrity)).toEqual(['sha384-AAA', 'sha384-BBB']);
  expect(await findSriProtectedScripts(dir)).toHaveLength(1);
});

it('MAX_HTML_BYTES is 8 MiB', () => {
  expect(MAX_HTML_BYTES).toBe(8 * 1024 * 1024);
});

/**
 * The reference the linear scanner must agree with: every `<!-- ... -->` removed by the regex it replaced. Spliced from
 * the match positions (not `String.replace`, which is also what a sanitiser would use: this is a test oracle).
 */
const referenceStrip = (text: string): string => {
  let out = '';
  let at = 0;
  for (const match of text.matchAll(HTML_COMMENT)) {
    out += text.slice(at, match.index);
    at = (match.index ?? 0) + match[0].length;
  }
  return out + text.slice(at);
};

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
      const markup = referenceStrip(text);
      expect(stripComments(text), JSON.stringify(text)).toBe(markup);
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

describe('the page walk fence is optional', () => {
  it('fenced (the default) skips test/ and dot-directories; unfenced scans them, still never node_modules', async () => {
    const dir = await fixture();
    const page = '<script src="/a.js" integrity="sha384-x"></script>';
    for (const sub of ['tests', '.well', 'node_modules', 'ok']) {
      await mkdir(join(dir, sub));
      await writeFile(join(dir, sub, 'p.html'), page.replace('/a.js', `../${sub}.js`));
    }
    const fenced = await findSriProtectedScriptsDetailed(dir);
    expect(fenced.scripts.map((s) => s.html)).toEqual([join(dir, 'ok', 'p.html')]);
    const open = await findSriProtectedScriptsDetailed(dir, MAX_HTML_BYTES, false);
    expect(open.scripts.map((s) => s.html).sort()).toEqual(
      [
        join(dir, '.well', 'p.html'),
        join(dir, 'ok', 'p.html'),
        join(dir, 'tests', 'p.html'),
      ].sort(),
    );
  });
});

describe('symlinked pages', () => {
  it('a link inside the directory is scanned; one outside or dangling is listed as unreadable', async () => {
    const dir = await fixture();
    const outside = await fixture();
    const page = '<script src="a.js" integrity="sha384-x"></script>';
    await mkdir(join(dir, 'tests')); // a directory the (default) fence skips: only the link can reach this page
    await writeFile(join(dir, 'tests', 'p.html'), page);
    await symlink(join(dir, 'tests', 'p.html'), join(dir, 'in.html'));
    await writeFile(join(outside, 'o.html'), page);
    await symlink(join(outside, 'o.html'), join(dir, 'out.html'));
    await symlink(join(outside, 'none.html'), join(dir, 'dangling.html'));
    const scan = await findSriProtectedScriptsDetailed(dir);
    expect(scan.scripts.map((s) => s.html)).toEqual([join(dir, 'in.html')]);
    expect(scan.unreadablePages.sort()).toEqual(
      [join(dir, 'dangling.html'), join(dir, 'out.html')].sort(),
    );
  });
});

describe('a page predicate skips pages before they are read', () => {
  it("a skipped page contributes no pins and cannot claim a later page's identical pin", async () => {
    const dir = await fixture();
    const page = '<script src="a.js" integrity="sha384-x"></script>';
    await mkdir(join(dir, 'a-skip'));
    await writeFile(join(dir, 'a-skip', 'p.html'), page.replace('a.js', '../a.js'));
    await writeFile(join(dir, 'z.html'), page);
    const all = await findSriProtectedScriptsDetailed(dir);
    expect(all.scripts.map((s) => s.html)).toEqual([join(dir, 'a-skip', 'p.html')]);
    const skipped: string[] = [];
    const scan = await findSriProtectedScriptsDetailed(dir, MAX_HTML_BYTES, true, (html) => {
      skipped.push(html);
      return html.includes('a-skip');
    });
    expect(scan.scripts.map((s) => s.html)).toEqual([join(dir, 'z.html')]);
    expect(skipped.sort()).toEqual([join(dir, 'a-skip', 'p.html'), join(dir, 'z.html')].sort());
    const big = join(dir, 'a-skip', 'big.html');
    await writeFile(big, '');
    await truncate(big, MAX_HTML_BYTES + 1);
    const again = await findSriProtectedScriptsDetailed(dir, MAX_HTML_BYTES, true, (html) =>
      html.includes('a-skip'),
    );
    expect(again.skippedPages).toEqual([]);
  });
});
