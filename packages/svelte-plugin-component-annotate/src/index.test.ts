import { describe, expect, it } from 'vitest';
import { componentAnnotatePreprocessor } from './index';

// INTEGRATION test: drives the preprocessor through the REAL `svelte/compiler` parse (devDep), proving the
// walker matches the actual Svelte AST — not just the hand-built fakes in annotate.test.ts.
describe('componentAnnotatePreprocessor (real svelte/compiler)', () => {
  const pre = componentAnnotatePreprocessor();

  it('annotates host elements in a real .svelte component, naming from the filename', () => {
    const result = pre.markup({
      content: '<script>let x = 1;</script>\n<div class="card"><span>{x}</span></div>',
      filename: '/src/lib/UserCard.svelte',
    });
    expect(result).toBeDefined();
    const code = result?.code ?? '';
    // both the root <div> and the nested <span> are attributed to the component (the file)
    expect(code).toContain('<div data-bugsee-component="UserCard" class="card">');
    expect(code).toContain('<span data-bugsee-component="UserCard">');
    // the <script> block + the {x} expression are untouched
    expect(code).toContain('<script>let x = 1;</script>');
  });

  it('annotates elements nested inside a control-flow block + leaves component tags alone', () => {
    const result = pre.markup({
      content: '{#if ok}<p>hi</p>{/if}<Child />',
      filename: 'Panel.svelte',
    });
    const code = result?.code ?? '';
    expect(code).toContain('<p data-bugsee-component="Panel">hi</p>');
    expect(code).toContain('<Child />'); // a component instance gets no DOM attribute
  });

  it('returns undefined for a non-.svelte file (no name → no transform)', () => {
    expect(pre.markup({ content: '<div></div>', filename: '/src/app.ts' })).toBeUndefined();
    expect(pre.markup({ content: '<div></div>' })).toBeUndefined(); // no filename
  });

  it('returns undefined for a .svelte file with no host elements to annotate', () => {
    expect(
      pre.markup({ content: '<script>const a = 1;</script>', filename: 'Empty.svelte' }),
    ).toBeUndefined();
  });
});
