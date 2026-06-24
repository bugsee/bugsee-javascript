// Derive a component name from a .svelte file path — the value emitted as `data-bugsee-component`. A Svelte
// component IS its file, so the basename is the name (`UserCard.svelte` → `UserCard`). Two cases have no
// meaningful basename and use the enclosing directory instead: `index.svelte` and SvelteKit's route files
// (`+page` / `+layout` / `+error` / `+server`), so `routes/dashboard/+page.svelte` → `dashboard`. Returns
// undefined for a non-.svelte path / an empty result (the preprocessor then leaves the file untouched).

const SVELTE_EXT = '.svelte';

export function componentNameFromFilename(filename: string | undefined): string | undefined {
  if (filename === undefined || !filename.endsWith(SVELTE_EXT)) return undefined;
  const parts = filename.split(/[\\/]/).filter((p) => p !== '');
  const base = parts[parts.length - 1];
  /* v8 ignore next -- unreachable: a `.svelte`-suffixed path always has a non-empty final segment; the guard
     only satisfies noUncheckedIndexedAccess. */
  if (base === undefined) return undefined;
  let name = base.slice(0, -SVELTE_EXT.length);
  if (name === 'index' || name.startsWith('+')) {
    const dir = parts[parts.length - 2];
    if (dir !== undefined) name = dir; // routes/dashboard/+page.svelte → 'dashboard'
  }
  name = name.replace(/^\+/, ''); // a residual leading '+' when no parent directory was available
  return name === '' ? undefined : name;
}
