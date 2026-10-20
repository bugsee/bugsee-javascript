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

describe('bakeIdentity leaves a LOCAL binding of the same name alone', () => {
  it.each([
    ['a function parameter', `function f(${V}) { return ${V}; }`],
    ['a function-expression parameter', `const f = function (${V}) { return ${V}; };`],
    ['an arrow parameter', `const f = (${V}) => ${V}; const g = ${V} => ${V};`],
    ['a defaulted and a rest parameter', `function f(${V} = 1, ...${B}) { return [${V}, ${B}]; }`],
    ['a destructured parameter', `function f({ a: [${V}], ...${B} }) { return [${V}, ${B}]; }`],
    ['a hoisted var read before its declaration', `function f() { use(${V}); { var ${V} = 1; } }`],
    [
      'a var in a nested statement',
      `function f() { if (c) { for (var ${V} of a) {} } return ${V}; }`,
    ],
    ['a const', `{ const ${V} = 1; use(${V}); }`],
    ['a let at module level', `let ${V} = 1; use(${V});`],
    ['a destructured const', `const { ${V} } = o; use(${V});`],
    ['a renamed destructured const', `const { x: ${V}, y: [${B}] } = o; use(${V}, ${B});`],
    ['a catch parameter', `try { f(); } catch (${V}) { use(${V}); }`],
    ['a for-of binding', `for (const ${V} of a) { use(${V}); }`],
    ['a for-in binding', `for (let ${V} in o) use(${V});`],
    ['a for-loop let', `for (let ${V} = 0; ${V} < 3; ${V}++) use(${V});`],
    ['an import', `import { ${V} } from 'm'; use(${V});`],
    [
      'an aliased default and namespace import',
      `import ${V}, * as ${B} from 'm'; use(${V}, ${B});`,
    ],
    ['a function declaration', `function ${V}() {} ${V}();`],
    ['a function declaration used before it is declared', `${V}(); function ${V}() {}`],
    [
      'a function declared in a block (sloppy: Annex B hoists it)',
      `{ function ${V}() {} } ${V}();`,
    ],
    ['a class declaration', `class ${V} {} new ${V}();`],
    [
      'a class expression name inside its body',
      `const C = class ${V} { m() { return new ${V}(); } };`,
    ],
    ['a named function expression inside its body', `const f = function ${V}() { return ${V}; };`],
    [
      'an exported declaration',
      `export const ${V} = 1; use(${V}); export function ${B}() {} ${B}();`,
    ],
    ['an exported default function', `export default function ${V}() { ${V}(); }`],
    ['an exported default class', `export default class ${V} { m() { return new ${V}(); } }`],
    ['a switch-case lexical declaration', `switch (a) { case 1: let ${V} = 1; use(${V}); }`],
    ['a class static block var', `class C { static { var ${V} = 1; use(${V}); } }`],
    ['a shorthand property that reads a local', `function f(${V}) { return { ${V} }; }`],
  ])('%s', (_, code) => {
    expect(bake(code)).toBeNull();
  });

  it('still bakes a global read beside a shadowed one in the same chunk', () => {
    expect(bake(`function f(${V}) { return ${V}; } use(${V}); function g() { return ${V}; }`)).toBe(
      `function f(${V}) { return ${V}; } use("2.4.1"); function g() { return "2.4.1"; }`,
    );
  });

  it('bakes once a nested function leaves the shadowing scope, and honours shadowing at each level', () => {
    expect(
      bake(
        `function a() { use(${V}); { let ${V} = 1; use(${V}); { use(${V}); } } use(${V}); ` +
          `(function () { var ${V}; use(${V}); })(); use(${V}); }`,
      ),
    ).toBe(
      `function a() { use("2.4.1"); { let ${V} = 1; use(${V}); { use(${V}); } } use("2.4.1"); ` +
        `(function () { var ${V}; use(${V}); })(); use("2.4.1"); }`,
    );
  });

  it('a block let does not shadow outside its block, nor a catch parameter outside its clause', () => {
    expect(bake(`{ let ${V} = 1; } use(${V}); try {} catch (${V}) {} use(${V});`)).toBe(
      `{ let ${V} = 1; } use("2.4.1"); try {} catch (${V}) {} use("2.4.1");`,
    );
  });

  it('a var inside a nested function does not shadow the enclosing scope', () => {
    expect(bake(`function f() { function g() { var ${V}; } return ${V}; }`)).toBe(
      `function f() { function g() { var ${V}; } return "2.4.1"; }`,
    );
  });

  it('a var inside a nested function or arrow expression does not shadow the enclosing scope', () => {
    expect(
      bake(
        `function f() { const g = function () { var ${V}; }; const h = () => { var ${B}; }; return [${V}, ${B}]; }`,
      ),
    ).toBe(
      `function f() { const g = function () { var ${V}; }; const h = () => { var ${B}; }; return ["2.4.1", "b7"]; }`,
    );
  });

  it('a parameter default and a class heritage still read the global', () => {
    expect(bake(`function f(a = ${V}) { return a; } class C extends ${B} {}`)).toBe(
      `function f(a = "2.4.1") { return a; } class C extends "b7" {}`,
    );
  });

  it('shadowing one constant leaves the other global', () => {
    expect(bake(`function f(${V}) { return [${V}, ${B}]; }`)).toBe(
      `function f(${V}) { return [${V}, "b7"]; }`,
    );
  });

  it('a static block var is local to the block, not the class', () => {
    expect(bake(`class C { static { var ${V}; } m() { return ${V}; } }`)).toBe(
      `class C { static { var ${V}; } m() { return "2.4.1"; } }`,
    );
  });
});

describe('bakeIdentity strict mode scopes a block function to its block', () => {
  const strict = (code: string) =>
    bakeIdentity(code, defines, parse, undefined, true)?.code ?? null;

  it('a function declared in a block does not shadow outside it in strict code', () => {
    expect(strict(`{ function ${V}() {} ${V}(); } use(${V});`)).toBe(
      `{ function ${V}() {} ${V}(); } use("2.4.1");`,
    );
  });

  it('but a function declared at the top level of a function or module still shadows', () => {
    expect(
      strict(`function f() { ${V}(); function ${V}() {} } function ${B}() {} ${B}();`),
    ).toBeNull();
  });

  it('a var in a block still hoists in strict code', () => {
    expect(strict(`function f() { { var ${V}; } return ${V}; }`)).toBeNull();
  });

  it('sloppy code keeps Annex B hoisting (the default when strictness is unknown)', () => {
    expect(bakeIdentity(`{ function ${V}() {} } ${V}();`, defines, parse)).toBeNull();
    expect(
      bakeIdentity(`{ function ${V}() {} } ${V}();`, defines, parse, undefined, false),
    ).toBeNull();
  });
});

describe('bakeIdentity scopes switch discriminants and default parameters exactly', () => {
  it('a switch discriminant is read outside the case block, case tests and bodies inside it', () => {
    expect(bake(`switch (${V}) { case 1: let ${V} = 1; use(${V}); }`)).toBe(
      `switch ("2.4.1") { case 1: let ${V} = 1; use(${V}); }`,
    );
    expect(bake(`switch (a) { case ${V}: let ${V}; }`)).toBeNull();
  });

  it.each([
    ['a body var', `function f(a = ${V}) { var ${V} = 1; return a; }`],
    ['a body function', `function f(a = ${V}) { function ${V}() {} return a; }`],
    ['an arrow body var', `const f = (a = ${V}) => { var ${V} = 1; return a; };`],
    ['a closure default', `function f(a = () => ${V}) { var ${V} = 1; return a; }`],
    ['a destructured default', `function f({ a = ${V} }) { var ${V} = 1; return a; }`],
    ['a rest parameter', `function f(...[a = ${V}]) { let ${V} = 1; return a; }`],
  ])('a default value does not see %s', (_, code) => {
    expect(bake(code)).toBe(code.replace(/= ((\(\) => )?)__BUGSEE_APP_VERSION__/, '= $1"2.4.1"'));
  });

  it('the body does see its own var when parameters have defaults, and a param still shadows', () => {
    expect(bake(`function f(a = 1) { var ${V} = 2; return ${V}; }`)).toBeNull();
    expect(bake(`function f(${V} = 1) { var ${V}; return ${V}; }`)).toBeNull();
    expect(bake(`function f(${V} = 1) { return ${V}; }`)).toBeNull();
  });

  it('a class name is in scope for its own computed keys and heritage', () => {
    expect(bake(`const C = class ${V} { [${V}]() {} };`)).toBeNull();
    expect(bake(`const C = class ${V} extends ${V}.base {};`)).toBeNull();
    expect(bake(`class C extends ${V} { [${V}]() {} }`)).toBe(
      `class C extends "2.4.1" { ["2.4.1"]() {} }`,
    );
  });

  it('with simple parameters a body var and the parameter list share one scope', () => {
    expect(bake(`function f(a, b) { var ${V} = 1; return ${V}; }`)).toBeNull();
    expect(bake(`function f(a, ${B}) { var ${B}; return ${B}; }`)).toBeNull();
  });
});

describe('bakeIdentity never throws while walking', () => {
  it('routes a walk failure to onSkipped and leaves the chunk alone', () => {
    const skipped = vi.fn();
    const broken = () => ({
      type: 'Program',
      start: 0,
      end: 0,
      get body(): never {
        throw new Error('visitor exploded');
      },
    });
    expect(bakeIdentity(`f(${V})`, defines, broken, skipped)).toBeNull();
    expect(skipped.mock.calls[0]?.[0]).toMatch(/could not be walked \(visitor exploded\)/);
  });

  it('survives a chunk nested deeper than the recursion limit', () => {
    const skipped = vi.fn();
    const deep = () => {
      let node: Record<string, unknown> = { type: 'Identifier', name: V, start: 0, end: 1 };
      for (let i = 0; i < 200000; i++) {
        node = { type: 'ExpressionStatement', start: 0, end: 1, expression: node };
      }
      return { type: 'Program', start: 0, end: 1, body: [node] };
    };
    expect(bakeIdentity(`f(${V})`, defines, deep, skipped)).toBeNull();
    expect(skipped.mock.calls[0]?.[0]).toMatch(/could not be walked/);
  });

  it('describes a non-Error walk failure and tolerates no callback', () => {
    const odd = () => ({
      type: 'Program',
      start: 0,
      end: 0,
      get body(): never {
        throw 'plain';
      },
    });
    const skipped = vi.fn();
    expect(bakeIdentity(`f(${V})`, defines, odd, skipped)).toBeNull();
    expect(skipped.mock.calls[0]?.[0]).toContain('(plain)');
    expect(bakeIdentity(`f(${V})`, defines, odd)).toBeNull();
  });
});

describe('bakeIdentity says when it could not examine a chunk', () => {
  it('reports a missing parser and a parse failure, with a reason, once per call', () => {
    const skipped = vi.fn();
    expect(bakeIdentity(`f(${V})`, defines, undefined, skipped)).toBeNull();
    expect(skipped).toHaveBeenCalledTimes(1);
    expect(skipped.mock.calls[0]?.[0]).toMatch(/no parser/);
    const failed = vi.fn();
    expect(bakeIdentity(`f(${V}) +`, defines, parse, failed)).toBeNull();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0]?.[0]).toMatch(/could not be parsed \(.+\)/);
  });

  it('describes a thrown non-Error and tolerates no callback', () => {
    const skipped = vi.fn();
    const throwing = (): never => {
      throw 'boom';
    };
    expect(bakeIdentity(`f(${V})`, defines, throwing, skipped)).toBeNull();
    expect(skipped.mock.calls[0]?.[0]).toContain('(boom)');
    expect(bakeIdentity(`f(${V})`, defines, throwing)).toBeNull();
  });

  it('stays quiet when the chunk never mentions a constant or parses and has nothing to bake', () => {
    const skipped = vi.fn();
    expect(bakeIdentity('const a = 1 +', defines, undefined, skipped)).toBeNull();
    expect(bakeIdentity(`const k = "${V}";`, defines, parse, skipped)).toBeNull();
    expect(skipped).not.toHaveBeenCalled();
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
    ['a class declaration or expression name', `class ${V} {} const C = class ${B} {};`],
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
