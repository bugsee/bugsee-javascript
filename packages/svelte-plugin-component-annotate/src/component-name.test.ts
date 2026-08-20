import { describe, expect, it } from 'vitest';
import { componentNameFromFilename } from './component-name';

describe('componentNameFromFilename', () => {
  it('derives the name from a .svelte file basename', () => {
    expect(componentNameFromFilename('/src/lib/UserCard.svelte')).toBe('UserCard');
    expect(componentNameFromFilename('Button.svelte')).toBe('Button');
  });

  it('tolerates Windows-style backslash separators', () => {
    expect(componentNameFromFilename('C:\\app\\src\\Modal.svelte')).toBe('Modal');
  });

  it('uses the parent directory name for index.svelte (no meaningful basename)', () => {
    expect(componentNameFromFilename('/src/widgets/chart/index.svelte')).toBe('chart');
  });

  it('uses the parent directory name for a SvelteKit route file (+page / +layout / +error)', () => {
    expect(componentNameFromFilename('/routes/dashboard/+page.svelte')).toBe('dashboard');
    expect(componentNameFromFilename('/routes/settings/+layout.svelte')).toBe('settings');
  });

  it('strips a residual leading + when there is no parent directory to fall back to', () => {
    expect(componentNameFromFilename('+page.svelte')).toBe('page');
  });

  it('keeps index/+page names when the only leading segment is an (empty) root slash', () => {
    // pins the empty-segment filter: '/index.svelte' splits to ['', 'index.svelte']; without the filter the
    // "parent dir" would be the empty root segment and the name would collapse to undefined.
    expect(componentNameFromFilename('/index.svelte')).toBe('index');
    expect(componentNameFromFilename('/+page.svelte')).toBe('page');
  });

  it('strips ONLY a leading +, never one inside the name', () => {
    // `Foo+Bar.svelte` is a perfectly legal file name; collapsing it to `FooBar` would silently attribute
    // the component under a name that appears nowhere in the project.
    expect(componentNameFromFilename('/src/Foo+Bar.svelte')).toBe('Foo+Bar');
    expect(componentNameFromFilename('/src/a+b+c.svelte')).toBe('a+b+c');
  });

  it('returns undefined for a non-.svelte file', () => {
    expect(componentNameFromFilename('/src/app.ts')).toBeUndefined();
    expect(componentNameFromFilename('/src/styles.css')).toBeUndefined();
  });

  it('returns undefined for an undefined filename', () => {
    expect(componentNameFromFilename(undefined)).toBeUndefined();
  });

  it('returns undefined when the resolved name is empty (e.g. bare ".svelte")', () => {
    expect(componentNameFromFilename('.svelte')).toBeUndefined();
  });
});
