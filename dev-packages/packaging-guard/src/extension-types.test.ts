import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `client.ext('performance')` is typed by a `declare module '@bugsee/types'` augmentation inside
// @bugsee/performance. TypeScript only loads an augmentation if the consumer's type graph reaches the
// package that declares it — and inside this monorepo it always does, because `exports` point at
// source and the whole graph is visible. In a PUBLISHED install it does not: the umbrella's .d.ts
// referenced @bugsee/browser, @bugsee/core and @bugsee/opentelemetry, and nothing else, so
// `client.ext('performance')` had no usable type for any customer.
//
// This asserts the property that actually broke: every package that augments the mapping is reachable
// from the umbrella's published types.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Packages whose source declaration-merges one of the @bugsee/types mapping interfaces. */
function augmentingPackages(): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', dir, 'src');
    if (!existsSync(src)) continue;
    const declares = readdirSync(src)
      .filter((f) => f.endsWith('.ts') && !f.includes('.test'))
      .some((f) => {
        const text = readFileSync(join(src, f), 'utf8');
        return text.includes("declare module '@bugsee/types'");
      });
    if (!declares) continue;
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'),
    ) as { name: string };
    // @bugsee/types is the augmentation TARGET, not an augmenter — its own source names the module.
    if (manifest.name === '@bugsee/types') continue;
    out.push(manifest.name);
  }
  return out.sort();
}

describe('type augmentations reach a published consumer', () => {
  const augmenting = augmentingPackages();

  it('finds the packages that augment @bugsee/types', () => {
    // A guard whose subject list silently emptied would pass every assertion below.
    expect(augmenting.length).toBeGreaterThan(0);
  });

  it.each(augmenting)("the umbrella's published types reference %s", (name) => {
    const dts = join(root, 'packages', 'bugsee', 'dist', 'index.d.ts');
    expect(existsSync(dts), 'run the build first').toBe(true);
    expect(
      readFileSync(dts, 'utf8').includes(name),
      `@bugsee/bugsee's published types never mention ${name}, so its module augmentation does not load for a consumer`,
    ).toBe(true);
  });
});
