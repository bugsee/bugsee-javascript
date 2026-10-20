// The Rollup bake must rewrite only real READS of the identity constants. A lexical match also hit string,
// template and comment text, and `"__BUGSEE_APP_VERSION__"` became `""2.4.1""` — a syntax error in the
// app's production bundle. Every case parses the emitted code to prove it is still valid JavaScript.
import { SourceMapConsumer } from 'source-map-js';
import { parseAst } from 'rollup/parseAst';
import { describe, expect, it, vi } from 'vitest';
import { bakeIdentity } from './bake-identity';

const V = '__BUGSEE_APP_VERSION__';
const B = '__BUGSEE_APP_BUILD__';
const defines = { [V]: '"2.4.1"', [B]: '"b7"' };
const parse = (code: string): unknown => parseAst(code);

/** Bake, and prove the output parses as a module. */
const bake = (code: string): string | null => {
  const out = bakeIdentity(code, defines, parse);
  if (out !== null) {
    expect(() => parseAst(out.code)).not.toThrow();
  }
  return out?.code ?? null;
};

describe('bakeIdentity replaces identifier references', () => {
  it('replaces a bare reference and a typeof check', () => {
    expect(bake(`const v = typeof ${V} === 'string' ? ${V} : '0.0.0'; f(${B});`)).toBe(
      `const v = typeof "2.4.1" === 'string' ? "2.4.1" : '0.0.0'; f("b7");`,
    );
  });

  it('replaces a computed member key and the object of a member expression', () => {
    expect(bake(`o[${V}]; ${V}.length;`)).toBe(`o["2.4.1"]; "2.4.1".length;`);
  });

  it('replaces a reference inside a labelled statement, but not the label', () => {
    expect(bake(`${V}: for (;;) { f(${V}); continue ${V}; }`)).toBe(
      `${V}: for (;;) { f("2.4.1"); continue ${V}; }`,
    );
  });

  it('replaces the object of a member being assigned (the target is the member, not the constant)', () => {
    expect(bake(`${V}.x = 1;`)).toBe(`"2.4.1".x = 1;`);
  });

  it('replaces a reference inside template expressions', () => {
    expect(bake(`t = \`v\${${V}}\`;`)).toBe(`t = \`v\${"2.4.1"}\`;`);
  });

  it('expands a shorthand property instead of producing `{ "2.4.1" }`', () => {
    expect(bake(`export const o = { ${V}, x: 1 };`)).toBe(
      `export const o = { ${V}: "2.4.1", x: 1 };`,
    );
  });

  it('replaces a reference in a default value and a computed key inside a pattern', () => {
    expect(bake(`const { a = ${V}, [${B}]: b } = o;`)).toBe(
      `const { a = "2.4.1", ["b7"]: b } = o;`,
    );
  });
});

describe('bakeIdentity leaves everything that is not a read alone', () => {
  it.each([
    ['a double-quoted string', `const k = "${V}";`],
    ['a single-quoted string', `globalThis['${V}'];`],
    ['template text', `const t = \`${V} is \${x}\`;`],
    ['a line comment', `// ${V}\nx();`],
    ['a block comment', `/* typeof ${V} */ x();`],
    ['a member property', `obj.${V}; obj?.${B};`],
    ['an object key and a class member', `({ ${V}: 1 }); class C { ${V} = 1; ${B}() {} }`],
    ['a declaration', `var ${V} = 1; function ${B}(${V}) {}`],
    ['a catch parameter', `try { x(); } catch (${V}) {}`],
    ['an assignment / update target', `${V} = 1; ${B}++; ${V} += 2;`],
    ['a destructuring target', `({ ${V} } = o); [${B}] = a; const { x: ${V} } = o;`],
    ['an import / export name', `import { ${V} } from 'm'; export { ${V} };`],
    ['a label', `${V}: for (;;) { break ${V}; }`],
    ['a longer identifier or a $-suffixed one', `${V}2; $${V}; ${V}$;`],
  ])('%s', (_, code) => {
    expect(bake(code)).toBeNull();
  });

  it('a chunk that never mentions the constant is not parsed at all', () => {
    const spy = vi.fn(parse);
    expect(bakeIdentity('const a = 1;', defines, spy)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('a chunk the parser rejects, or no parser, is left untouched rather than guessed at', () => {
    expect(bakeIdentity(`${V} +`, defines, parse)).toBeNull();
    expect(bakeIdentity(`f(${V})`, defines, undefined)).toBeNull();
  });

  it('nothing to bake is a no-op', () => {
    expect(bakeIdentity(`f(${V})`, {}, parse)).toBeNull();
  });
});

describe('bakeIdentity keeps the source map exact', () => {
  it('maps a column after the replacement back to its original column', () => {
    const code = `f(${V}); g(1);`;
    const out = bakeIdentity(code, defines, parse);
    expect(out?.code).toBe('f("2.4.1"); g(1);');
    const consumer = new SourceMapConsumer({ ...out!.map, sources: ['chunk.js'] } as never);
    const gColumn = out!.code.indexOf('g(1)');
    const original = consumer.originalPositionFor({ line: 1, column: gColumn });
    expect(original.column).toBe(code.indexOf('g(1)'));
  });
});
