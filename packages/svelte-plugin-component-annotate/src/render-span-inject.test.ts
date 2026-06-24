import { describe, expect, it } from 'vitest';
import { injectRenderSpan } from './render-span-inject';

describe('injectRenderSpan', () => {
  it('prepends an onMount-based render-span call (imports + the component name) to an instance script', () => {
    const result = injectRenderSpan({
      content: 'let count = 0;',
      filename: '/src/lib/UserCard.svelte',
    });
    expect(result).toBeDefined();
    const code = result?.code ?? '';
    expect(code).toContain("import { onMount as __bugsee_onMount } from 'svelte';");
    expect(code).toContain(
      "import { startSvelteRenderSpan as __bugsee_startRenderSpan } from '@bugsee/svelte';",
    );
    expect(code).toContain('__bugsee_onMount(__bugsee_startRenderSpan("UserCard"));');
    expect(code).toContain('let count = 0;'); // the original script is preserved (appended after)
    expect(code.endsWith('let count = 0;')).toBe(true);
  });

  it('skips a Svelte 4 module script (<script context="module">)', () => {
    expect(
      injectRenderSpan({
        content: 'export const x = 1;',
        attributes: { context: 'module' },
        filename: 'A.svelte',
      }),
    ).toBeUndefined();
  });

  it('skips a Svelte 5 module script (<script module>)', () => {
    expect(
      injectRenderSpan({
        content: 'export const x = 1;',
        attributes: { module: true },
        filename: 'A.svelte',
      }),
    ).toBeUndefined();
  });

  it('still injects into a typed instance script (lang="ts" is not a module script)', () => {
    const result = injectRenderSpan({
      content: 'let n: number = 0;',
      attributes: { lang: 'ts' },
      filename: 'Widget.svelte',
    });
    expect(result?.code).toContain('__bugsee_startRenderSpan("Widget")');
  });

  it('returns undefined when no component name resolves (no / non-.svelte filename)', () => {
    expect(injectRenderSpan({ content: 'x', filename: '/src/app.ts' })).toBeUndefined();
    expect(injectRenderSpan({ content: 'x' })).toBeUndefined();
  });

  it('is idempotent — does not double-inject when the marker is already present', () => {
    const once = injectRenderSpan({ content: 'let a = 1;', filename: 'A.svelte' });
    expect(injectRenderSpan({ content: once?.code ?? '', filename: 'A.svelte' })).toBeUndefined();
  });

  it('uses the parent directory name for a SvelteKit route file (+page.svelte)', () => {
    const result = injectRenderSpan({ content: '', filename: '/routes/dashboard/+page.svelte' });
    expect(result?.code).toContain('__bugsee_startRenderSpan("dashboard")');
  });

  it('escapes a name with special characters via JSON.stringify (a valid string literal)', () => {
    // an exotic filename with a quote must emit a properly-escaped literal, not a broken `"My"Quote"`.
    const result = injectRenderSpan({ content: '', filename: 'My"Quote.svelte' });
    expect(result?.code).toContain('__bugsee_startRenderSpan("My\\"Quote")');
  });
});
