import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectBuildFiles, mapPointerOf, pairByPointer, partitionBuildFiles } from './build-files';

describe('partitionBuildFiles', () => {
  it('pairs each bundle with its map and sorts both', () => {
    const files = ['/o/b.js.map', '/o/a.js', '/o/b.js', '/o/a.js.map'];
    expect(partitionBuildFiles(files)).toEqual({
      scripts: ['/o/a.js', '/o/b.js'],
      maps: ['/o/a.js.map', '/o/b.js.map'],
      stylesheetMaps: [],
    });
  });

  it('accepts an upper-case extension, as the core does', () => {
    expect(partitionBuildFiles(['/o/A.JS', '/o/A.JS.map']).scripts).toEqual(['/o/A.JS']);
  });

  it('accepts .mjs and .cjs bundles', () => {
    const files = ['/o/a.mjs', '/o/a.mjs.map', '/o/b.cjs', '/o/b.cjs.map'];
    expect(partitionBuildFiles(files).scripts).toEqual(['/o/a.mjs', '/o/b.cjs']);
  });

  it('never stamps a bundle that has no map, and never sends a map that has no bundle', () => {
    const files = ['/o/lonely.js', '/o/orphan.js.map', '/o/ok.js', '/o/ok.js.map'];
    const parts = partitionBuildFiles(files);
    expect(parts.scripts).toEqual(['/o/ok.js']);
    expect(parts.maps).toEqual(['/o/ok.js.map']);
  });

  it('keeps stylesheet maps apart: deleted with the rest, never sent', () => {
    const files = ['/o/a.css', '/o/a.css.map', '/o/a.js', '/o/a.js.map'];
    const parts = partitionBuildFiles(files);
    expect(parts.stylesheetMaps).toEqual(['/o/a.css.map']);
    expect(parts.maps).toEqual(['/o/a.js.map']);
  });

  it('ignores everything else', () => {
    expect(partitionBuildFiles(['/o/a.html', '/o/a.json', '/o/a.png'])).toEqual({
      scripts: [],
      maps: [],
      stylesheetMaps: [],
    });
  });
});

describe('mapPointerOf', () => {
  it('resolves the pointer against the bundle directory', () => {
    expect(mapPointerOf('/o/chunks/a.js', 'code();\n//# sourceMappingURL=other.js.map\n')).toBe(
      '/o/chunks/other.js.map',
    );
    expect(mapPointerOf('/o/chunks/a.js', 'x\n//@ sourceMappingURL=../m/a.map')).toBe('/o/m/a.map');
  });

  it('decodes a percent-encoded pointer (Turbopack names contain brackets)', () => {
    expect(mapPointerOf('/o/a.js', 'x\n//# sourceMappingURL=%5Broot%5D__a._.js.map\n')).toBe(
      '/o/[root]__a._.js.map',
    );
  });

  it('uses a pointer as written when it is not valid percent-encoding', () => {
    expect(mapPointerOf('/o/a.js', 'x\n//# sourceMappingURL=100%.js.map')).toBe('/o/100%.js.map');
  });

  it('reads a stylesheet pointer from its /*# */ comment, not the // form', () => {
    expect(mapPointerOf('/o/a.css', 'a{}\n/*# sourceMappingURL=a.css.map */')).toBe('/o/a.css.map');
    expect(mapPointerOf('/o/a.css', 'a{}\n//# sourceMappingURL=a.css.map')).toBeUndefined();
    expect(mapPointerOf('/o/a.js', 'x\n/*# sourceMappingURL=a.js.map */')).toBeUndefined();
  });

  it('has no pointer for a bundle without a comment, or with an inline map', () => {
    expect(mapPointerOf('/o/a.js', 'no comment')).toBeUndefined();
    expect(
      mapPointerOf('/o/a.js', 'x\n//# sourceMappingURL=data:application/json;base64,e30='),
    ).toBeUndefined();
  });

  it('only counts the comment that ends the bundle', () => {
    expect(mapPointerOf('/o/a.js', '//# sourceMappingURL=a.map\nmore();')).toBeUndefined();
  });
});

describe('pairByPointer', () => {
  const code = (map: string): string => `code();\n//# sourceMappingURL=${map}\n`;
  const reader = (sources: Record<string, string>) => async (file: string) => sources[file] ?? '';

  it('pairs a bundle with a map that is NOT named after it', async () => {
    const files = ['/o/0ihtw.js', '/o/1wkfrb.js.map'];
    const parts = await pairByPointer(files, reader({ '/o/0ihtw.js': code('1wkfrb.js.map') }));
    expect(parts).toEqual({
      scripts: ['/o/0ihtw.js'],
      maps: ['/o/1wkfrb.js.map'],
      stylesheetMaps: [],
      shared: [],
    });
  });

  it('ignores a pointer to a file that is not there', async () => {
    const parts = await pairByPointer(['/o/a.js'], reader({ '/o/a.js': code('gone.js.map') }));
    expect(parts.scripts).toEqual([]);
  });

  it('ignores a pointer to something that is not a map', async () => {
    const parts = await pairByPointer(['/o/a.js', '/o/b.js'], reader({ '/o/a.js': code('b.js') }));
    expect(parts.scripts).toEqual([]);
    expect(parts.maps).toEqual([]);
  });

  it('pairs neither bundle of a map two bundles share, and reports them', async () => {
    const parts = await pairByPointer(
      ['/o/a.js', '/o/b.js', '/o/shared.js.map', '/o/c.js', '/o/c.js.map'],
      reader({
        '/o/a.js': code('shared.js.map'),
        '/o/b.js': code('shared.js.map'),
        '/o/c.js': code('c.js.map'),
      }),
    );
    expect(parts.scripts).toEqual(['/o/c.js']);
    expect(parts.maps).toEqual(['/o/c.js.map']);
    expect(parts.shared).toEqual(['/o/a.js', '/o/b.js']);
  });

  it('does not read files that are not scripts', async () => {
    const read = vi.fn(async () => '');
    await pairByPointer(['/o/a.json', '/o/a.js.map', '/o/a.txt'], read);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps this build's stylesheet maps apart (a stylesheet points at them): deleted, never sent", async () => {
    const css = (map: string): string => `a{}\n/*# sourceMappingURL=${map} */\n`;
    const parts = await pairByPointer(
      ['/o/a.css', '/o/x1.map'],
      reader({ '/o/a.css': css('x1.map') }),
    );
    expect(parts.stylesheetMaps).toEqual(['/o/x1.map']);
    expect(parts.maps).toEqual([]);
  });

  it("leaves a stylesheet or declaration map nothing points at alone: it is not this build's", async () => {
    const parts = await pairByPointer(
      ['/o/a.css', '/o/a.css.map', '/o/foreign.css.map', '/o/types.d.ts.map'],
      reader({ '/o/a.css': 'a{}\n/*# sourceMappingURL=a.css.map */' }),
    );
    expect(parts.stylesheetMaps).toEqual(['/o/a.css.map']);
  });

  it('ignores a stylesheet pointer to a missing or non-map file, or an inline map', async () => {
    const parts = await pairByPointer(
      ['/o/a.css', '/o/b.css', '/o/c.css', '/o/c.txt'],
      reader({
        '/o/a.css': 'a{}/*# sourceMappingURL=gone.css.map */',
        '/o/b.css': 'a{}/*# sourceMappingURL=c.txt */',
        '/o/c.css': 'a{}/*# sourceMappingURL=data:application/json;base64,e30= */',
      }),
    );
    expect(parts.stylesheetMaps).toEqual([]);
  });

  it('sorts its output', async () => {
    const parts = await pairByPointer(
      ['/o/z.js', '/o/a.js', '/o/m1.map', '/o/m0.map'],
      reader({ '/o/z.js': code('m1.map'), '/o/a.js': code('m0.map') }),
    );
    expect(parts.scripts).toEqual(['/o/a.js', '/o/z.js']);
    expect(parts.maps).toEqual(['/o/m0.map', '/o/m1.map']);
  });
});

describe('collectBuildFiles', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bugsee-bf-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const put = (rel: string, content = 'x'): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  const bundle = (rel: string, mapName = `${rel.split('/').pop()}.map`): void => {
    put(rel, `code();\n//# sourceMappingURL=${encodeURIComponent(mapName)}\n`);
    put(`${rel}/../${mapName}`);
  };

  it('walks nested directories, bracketed names included', async () => {
    bundle('chunks/[root-of-the-server]__a._.js');
    bundle('chunks/ssr/b.js');
    const parts = await collectBuildFiles(root);
    expect(parts.scripts).toEqual([
      join(root, 'chunks/[root-of-the-server]__a._.js'),
      join(root, 'chunks/ssr/b.js'),
    ]);
    expect(parts.maps).toHaveLength(2);
  });

  it('pairs by the pointer inside the bundle when the map has another name', async () => {
    bundle('chunks/0ihtw.js', '1wkfrb.js.map');
    const parts = await collectBuildFiles(root);
    expect(parts.scripts).toEqual([join(root, 'chunks/0ihtw.js')]);
    expect(parts.maps).toEqual([join(root, 'chunks/1wkfrb.js.map')]);
  });

  it('never descends into node_modules', async () => {
    bundle('node_modules/x/a.js');
    bundle('ok.js');
    expect((await collectBuildFiles(root)).scripts).toEqual([join(root, 'ok.js')]);
  });

  it('does descend into a route directory that happens to be called cache', async () => {
    bundle('chunks/app/cache/page.js');
    expect((await collectBuildFiles(root)).scripts).toEqual([
      join(root, 'chunks/app/cache/page.js'),
    ]);
  });

  it('returns nothing for a directory that does not exist', async () => {
    expect(await collectBuildFiles(join(root, 'absent'))).toEqual({
      scripts: [],
      maps: [],
      stylesheetMaps: [],
      shared: [],
    });
  });

  it('stops at a depth limit instead of walking an unbounded tree', async () => {
    bundle(`${Array.from({ length: 14 }, (_, i) => `d${i}`).join('/')}/a.js`);
    bundle('top.js');
    expect((await collectBuildFiles(root)).scripts).toEqual([join(root, 'top.js')]);
  });
});
