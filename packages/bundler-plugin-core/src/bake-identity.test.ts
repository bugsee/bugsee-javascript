// The Rollup bake must rewrite only real READS of the identity constants. A lexical match also hit string,
// template and comment text, and `"__BUGSEE_APP_VERSION__"` became `""2.4.1""` — a syntax error in the
// app's production bundle. Every case parses the emitted code to prove it is still valid JavaScript.
import { parseAst } from 'rollup/parseAst';
import { describe, expect, it, vi } from 'vitest';
import { bakeIdentity } from './bake-identity';

const V = '__BUGSEE_APP_VERSION__';
const B = '__BUGSEE_APP_BUILD__';
const defines = { [V]: '"2.4.1"', [B]: '"b7"' };
const parse = (code: string): unknown => parseAst(code);

/** Decode a v3 `mappings` string into per-line arrays of [generatedColumn, sourceIndex, line, column]. */
function decodeMappings(mappings: string): number[][][] {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let source = 0;
  let srcLine = 0;
  let srcCol = 0;
  return mappings.split(';').map((line) => {
    let genCol = 0;
    return line === ''
      ? []
      : line.split(',').map((segment) => {
          const values: number[] = [];
          let shift = 0;
          let acc = 0;
          for (const ch of segment) {
            const digit = chars.indexOf(ch);
            acc += (digit & 31) << shift;
            if (digit & 32) {
              shift += 5;
            } else {
              values.push(acc & 1 ? -(acc >> 1) : acc >> 1);
              acc = 0;
              shift = 0;
            }
          }
          genCol += values[0] as number;
          source += values[1] as number;
          srcLine += values[2] as number;
          srcCol += values[3] as number;
          return [genCol, source, srcLine, srcCol];
        });
  });
}

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

describe('bakeIdentity handles text that merely spells the name', () => {
  it('rewrites the reference but not a string, template text, comment or regex beside it', () => {
    const code = [
      `const a = "${V}", b = '${V}', c = \`${V}\`;`,
      `// ${V}`,
      `const re = /${V}/g; /* ${B} */`,
      `f(${V});`,
    ].join('\n');
    expect(bake(code)).toBe(code.replace(`f(${V});`, 'f("2.4.1");'));
  });

  it('is not fooled by an escaped quote that makes a string look like it ends early', () => {
    const code = `const s = "say \\"${V}\\" now", t = 'it\\'s ${V}'; f(${V});`;
    expect(bake(code)).toBe(code.replace(`f(${V});`, 'f("2.4.1");'));
  });

  it('rewrites a reference in a template expression but not the text around or a string inside it', () => {
    const code = `t = \`${V} \${"${V}"} \${${V}}\`;`;
    expect(bake(code)).toBe(`t = \`${V} \${"${V}"} \${"2.4.1"}\`;`);
  });

  it('handles nested template literals', () => {
    const code = `t = \`a ${V} \${\`b ${V} \${${V}}\`}\`;`;
    expect(bake(code)).toBe(`t = \`a ${V} \${\`b ${V} \${"2.4.1"}\`}\`;`);
  });

  it('replaces a reference after a regex literal containing quotes and a division', () => {
    const code = `x = /["'\\/]${V}/.test(s) ? a / ${V} : 1;`;
    expect(bake(code)).toBe(`x = /["'\\/]${V}/.test(s) ? a / "2.4.1" : 1;`);
  });

  it('replaces export default, a computed object key, a default parameter and a call argument', () => {
    expect(bake(`export default ${V};`)).toBe(`export default "2.4.1";`);
    expect(bake(`const o = { [${V}]: 1, k: ${B} };`)).toBe(`const o = { ["2.4.1"]: 1, k: "b7" };`);
    expect(bake(`const f = (a = ${V}) => a; class C { m(a = ${B}) {} }`)).toBe(
      `const f = (a = "2.4.1") => a; class C { m(a = "b7") {} }`,
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
    ['a for-in / for-of target', `for (${V} in o) {} for (${B} of a) {}`],
    ['an export-all namespace name', `export * as ${V} from 'm';`],
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
    const out = bakeIdentity(code, defines, parse) as NonNullable<ReturnType<typeof bakeIdentity>>;
    expect(out.code).toBe('f("2.4.1"); g(1);');
    const segments = decodeMappings(out.map.mappings)[0] as number[][];
    const gColumn = out.code.indexOf('g(1)');
    const hit = segments.find((segment) => segment[0] === gColumn);
    expect(hit?.[3]).toBe(code.indexOf('g(1)'));
  });
});
