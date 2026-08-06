import { types as babelTypes, transformSync } from '@babel/core';
import { describe, expect, it } from 'vitest';
import componentAnnotatePlugin from './index';

function transform(code: string): string {
  const out = transformSync(code, {
    plugins: ['@babel/plugin-syntax-jsx', componentAnnotatePlugin], // babel resolves the syntax plugin by name
    configFile: false,
    babelrc: false,
  });
  return out?.code ?? '';
}

describe('componentAnnotatePlugin', () => {
  it('annotates a host element with the enclosing function component name', () => {
    expect(transform('function UserCard() { return <div>hi</div>; }')).toContain(
      'data-bugsee-component="UserCard"',
    );
  });

  it('annotates an arrow component assigned to a PascalCase const', () => {
    expect(transform('const Avatar = () => <img src="a" />;')).toContain(
      'data-bugsee-component="Avatar"',
    );
  });

  it('annotates a class component (render) with the class name', () => {
    const out = transform(
      'class Panel extends Component { render() { return <section>x</section>; } }',
    );
    expect(out).toContain('data-bugsee-component="Panel"');
  });

  it('annotates EACH host element with its OWN defining component (nested components)', () => {
    const out = transform(
      'function A() { return <div><B /></div>; } function B() { return <button>go</button>; }',
    );
    expect(out).toContain('<div data-bugsee-component="A"'); // div defined in A
    expect(out).toContain('<button data-bugsee-component="B"'); // button defined in B
  });

  it('annotates a component wrapped in memo / forwardRef (attributes to the const name)', () => {
    expect(transform('const Card = memo(() => <div>x</div>);')).toContain(
      'data-bugsee-component="Card"',
    );
    expect(transform('const Field = forwardRef((p, ref) => <input ref={ref} />);')).toContain(
      'data-bugsee-component="Field"',
    );
    expect(
      transform('const Panel = memo(function Inner() { return <section>x</section>; });'),
    ).toContain('data-bugsee-component="Panel"');
  });

  it('uses the const name for a const-assigned class expression (not its inner class id)', () => {
    // `const Foo = class Bar {}` → "Foo" (the const), consistent with `const Foo = function Bar(){}`.
    const out = transform('const Foo = class Bar { render() { return <div>x</div>; } };');
    expect(out).toContain('data-bugsee-component="Foo"');
    expect(out).not.toContain('data-bugsee-component="Bar"');
  });

  it('does NOT annotate component (PascalCase) JSX elements — only host (lowercase) elements', () => {
    const out = transform('function A() { return <Widget>x</Widget>; }');
    expect(out).not.toContain('data-bugsee-component'); // <Widget> is a component, gets nothing
  });

  it('attributes JSX in a nested callback to the ENCLOSING component (callbacks are not components)', () => {
    const out = transform(
      'function List({ items }) { return <ul>{items.map(i => <li>{i}</li>)}</ul>; }',
    );
    expect(out).toContain('<ul data-bugsee-component="List"');
    expect(out).toContain('<li data-bugsee-component="List"'); // the map callback isn't a component → List
  });

  it('does NOT annotate JSX that is not inside a component (a lowercase helper fn)', () => {
    expect(transform('function render() { return <div>x</div>; }')).not.toContain(
      'data-bugsee-component',
    );
  });

  it('does NOT annotate a lowercase-named arrow assigned to a const (not a component)', () => {
    // `const renderRow = () => <tr/>` is a helper, not a component — its name is not PascalCase.
    expect(transform('const renderRow = () => <tr>x</tr>;')).not.toContain('data-bugsee-component');
  });

  it('RESETS the scope per file (pre) — an aborted file does not leak into the next on a reused instance', () => {
    // babel reuses one plugin instance across a multi-file build; pre() resets the closure per file so an
    // aborted transform (component pushed, then a throw before exit pops it) can't leak into the next file.
    const instance = componentAnnotatePlugin({ types: babelTypes });
    const boom = () => ({
      visitor: {
        JSXOpeningElement() {
          throw new Error('abort mid-component');
        },
      },
    });
    // File 1 aborts after the scope is pushed (boom throws on the <div>, before our exit/pop runs).
    expect(() =>
      transformSync('function A() { return <div/>; }', {
        plugins: ['@babel/plugin-syntax-jsx', instance, boom],
        configFile: false,
        babelrc: false,
      }),
    ).toThrow();
    // File 2 on the SAME instance — its <span> must NOT inherit A's leaked scope (pre() reset it).
    const out2 =
      transformSync('function helper() { return <span/>; }', {
        plugins: ['@babel/plugin-syntax-jsx', instance],
        configFile: false,
        babelrc: false,
      })?.code ?? '';
    expect(out2).not.toContain('data-bugsee-component');
  });

  it('POPS the component scope on exit — a helper AFTER a component is not attributed to it', () => {
    // If the stack were not popped, `helper`'s <span> would inherit the stale "A" component name.
    const out = transform('function A() { return <div/>; } function helper() { return <span/>; }');
    expect(out).toContain('<div data-bugsee-component="A"'); // A's div annotated
    expect(out).not.toContain('<span data-bugsee-component'); // helper's span NOT annotated (scope popped)
  });

  it('is idempotent — does not double-add when the attribute is already present', () => {
    const out = transform('function A() { return <div data-bugsee-component="Manual">x</div>; }');
    expect(out.match(/data-bugsee-component/g)?.length).toBe(1); // kept the manual one, not doubled
    expect(out).toContain('data-bugsee-component="Manual"');
  });

  it('leaves a member/namespaced JSX element (e.g. <Foo.Bar/>) untouched', () => {
    const out = transform('function A() { return <Foo.Bar>x</Foo.Bar>; }');
    expect(out).not.toContain('data-bugsee-component');
  });
});

// WAVE 7 — the attribution logic was entirely unpinned, and 5 of 5 targeted mutations survived.
//
// The test named "annotates EACH host element with its OWN defining component (nested components)" contains
// SIBLINGS, not nested components: `function A(){…} function B(){…}` at top level. The component stack
// therefore never exceeds depth 1, so `componentStack[componentStack.length - 1]` and `componentStack[0]`
// are indistinguishable, and `pop()` and `shift()` behave identically. Replacing innermost with OUTERMOST
// passed all 14 tests.
//
// Genuine nesting is what a real React file looks like — a component defined inside another, a render prop,
// a class method returning JSX — and it is where the attribution either works or silently names the wrong
// component in every issue the SDK reports.
describe('attribution under GENUINE nesting', () => {
  it('names the INNERMOST enclosing component, not the outermost', () => {
    const out = transform(
      'function Outer() { function Inner() { return <button>go</button>; } return <div><Inner /></div>; }',
    );
    expect(out).toContain('<button data-bugsee-component="Inner"');
    expect(out).toContain('<div data-bugsee-component="Outer"');
  });

  it('attributes a render prop to the component that DEFINES it', () => {
    // The arrow is not itself a named component, so the enclosing one owns its elements.
    const out = transform(
      'function List() { return <Box render={() => <li>item</li>}><span>hdr</span></Box>; }',
    );
    expect(out).toContain('<li data-bugsee-component="List"');
    expect(out).toContain('<span data-bugsee-component="List"');
  });

  it('POPS the stack, so a sibling after a nested component is not misattributed', () => {
    // The direct `pop()` vs `shift()` discriminator: after Inner closes, Outer's own element must be
    // Outer's. With `shift()` the wrong end is removed and the stack is left holding `Inner`.
    const out = transform(
      'function Outer() { const Inner = () => <em>i</em>; return <div><Inner /><p>after</p></div>; }',
    );
    expect(out).toContain('<em data-bugsee-component="Inner"');
    expect(out).toContain('<p data-bugsee-component="Outer"');
  });

  it('handles three levels', () => {
    const out = transform(
      'function A() { function B() { function C() { return <i>c</i>; } return <b><C /></b>; } return <a href="#"><B /></a>; }',
    );
    expect(out).toContain('<i data-bugsee-component="C"');
    expect(out).toContain('<b data-bugsee-component="B"');
    expect(out).toContain('<a href="#" data-bugsee-component="A"');
  });
});

// TypeScript was entirely untested, despite `.tsx` being the PRIMARY target — every React app this feature
// exists for is written in it.
describe('TypeScript (.tsx)', () => {
  const transformTsx = (code: string): string =>
    transformSync(code, {
      plugins: [['@babel/plugin-syntax-typescript', { isTSX: true }], componentAnnotatePlugin],
      configFile: false,
      babelrc: false,
    })?.code ?? '';

  it('annotates a typed function component', () => {
    expect(
      transformTsx('function Card({ id }: { id: string }) { return <div>{id}</div>; }'),
    ).toContain('data-bugsee-component="Card"');
  });

  it('annotates a typed arrow component with an explicit FC-style annotation', () => {
    expect(
      transformTsx('const Avatar: React.FC<{ src: string }> = ({ src }) => <img src={src} />;'),
    ).toContain('data-bugsee-component="Avatar"');
  });

  it('names the innermost component under nesting in TSX too', () => {
    const out = transformTsx(
      'function Outer(): JSX.Element { const Inner = (): JSX.Element => <em>i</em>; return <div><Inner /></div>; }',
    );
    expect(out).toContain('<em data-bugsee-component="Inner"');
    expect(out).toContain('<div data-bugsee-component="Outer"');
  });

  it('leaves a generic arrow’s type parameters intact', () => {
    // `<T,>(…) => …` in TSX is the shape most likely to confuse a JSX-aware transform.
    const out = transformTsx('const Pick = <T,>(xs: T[]) => <ul>{xs.length}</ul>;');
    expect(out).toContain('data-bugsee-component="Pick"');
  });
});

// SEV2 #1 — a peer plugin's nested `transformSync` wiped the shared stack.
//
// `pre()` resets a closure held per plugin INSTANCE, but babel calls it per File. The
// `babel-plugin-macros` / `preval` / `codegen` family transforms code mid-traversal, which re-enters this
// plugin's `pre()` on the same instance and silently drops every remaining annotation in the OUTER file.
// Proven in the review: 2 expected annotations became 0.
describe('re-entrancy: a peer plugin transforming mid-traversal', () => {
  /** A peer that runs a nested `transformSync` while the outer file is still being traversed. */
  const nestedTransformPeer = () => ({
    visitor: {
      JSXText(): void {
        transformSync('function Nested() { return <span>x</span>; }', {
          plugins: ['@babel/plugin-syntax-jsx', componentAnnotatePlugin],
          configFile: false,
          babelrc: false,
        });
      },
    },
  });

  it('keeps annotating the outer file after a nested transform re-enters pre()', () => {
    const out =
      transformSync('function Outer() { return <div>text<p>more</p></div>; }', {
        plugins: ['@babel/plugin-syntax-jsx', componentAnnotatePlugin, nestedTransformPeer],
        configFile: false,
        babelrc: false,
      })?.code ?? '';
    expect(out).toContain('<div data-bugsee-component="Outer"');
    expect(out).toContain('<p data-bugsee-component="Outer"');
  });
});
