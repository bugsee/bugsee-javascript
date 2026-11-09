import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { record } from './index';

const require = createRequire(import.meta.url);

describe('@bugsee/rrweb wrapper', () => {
  it('re-exports the rrweb record function (the single record-path import point)', () => {
    // The wrapper decouples @bugsee/replay from rrweb's packaging — swapping npm → the Bugsee fork touches
    // only this module. Assert the value it forwards is rrweb's callable record().
    expect(typeof record).toBe('function');
  });

  it('is wired to the 2.2.1 record-only bundle', () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(require.resolve('@bugsee/rrweb-record')), 'package.json'), 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe('2.2.1');
  });
});
