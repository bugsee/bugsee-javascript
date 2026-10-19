// Rollup has no `define`, so the app-identity constants are baked into each rendered chunk here, with a source
// map (a replacement changes the length of a line, and a stale map would point every later column wrong).
import MagicString from 'magic-string';

/** The pieces of a rendered chunk Rollup chains: the new code and the map that produced it. */
export interface BakedChunk {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace each free occurrence of a constant (`__BUGSEE_APP_VERSION__`) with its value expression, leaving a
 * longer identifier, a `$`-prefixed or `.`-accessed name alone. `null` when there is nothing to replace, so
 * Rollup keeps the chunk (and its map) untouched.
 */
export function bakeIdentity(code: string, defines: Record<string, string>): BakedChunk | null {
  const out = new MagicString(code);
  let changed = false;
  for (const [key, value] of Object.entries(defines)) {
    const free = new RegExp(`(?<![\\w$.])${escapeRegExp(key)}(?![\\w$])`, 'g');
    for (const match of code.matchAll(free)) {
      out.overwrite(match.index, match.index + key.length, value);
      changed = true;
    }
  }
  return changed ? { code: out.toString(), map: out.generateMap({ hires: true }) } : null;
}
