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
