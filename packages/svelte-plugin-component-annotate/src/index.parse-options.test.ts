import { describe, expect, it, vi } from 'vitest';

// `svelte/compiler` is mocked here ONLY to observe how the preprocessor CALLS it. Kept in its own file so
// index.test.ts keeps driving the real parser.
const { parseSpy } = vi.hoisted(() => ({
  parseSpy: vi.fn((_source: string, _options?: unknown) => ({ html: { children: [] } })),
}));
vi.mock('svelte/compiler', () => ({ parse: parseSpy }));

const { componentAnnotatePreprocessor } = await import('./index');

describe('the preprocessor tells Svelte which file it is parsing', () => {
  it('forwards the filename to `parse`, so a syntax error names the component file', () => {
    // The plugin swallows a parse failure by design and defers to Svelte's own compiler for the
    // diagnostic. If the filename were dropped here, THAT diagnostic would point at nothing.
    parseSpy.mockClear();
    componentAnnotatePreprocessor().markup({
      content: '<div></div>',
      filename: '/src/lib/UserCard.svelte',
    });
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(parseSpy.mock.calls[0]?.[0]).toBe('<div></div>');
    expect(parseSpy.mock.calls[0]?.[1]).toEqual({ filename: '/src/lib/UserCard.svelte' });
  });

  it('does not call the parser at all for a file it cannot name', () => {
    parseSpy.mockClear();
    componentAnnotatePreprocessor().markup({ content: '<div></div>', filename: '/src/app.ts' });
    componentAnnotatePreprocessor().markup({ content: '<div></div>' });
    expect(parseSpy).not.toHaveBeenCalled();
  });
});
