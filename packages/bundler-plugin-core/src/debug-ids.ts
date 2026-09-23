// The debug-ids `bugsee-cli sourcemaps inject` stamped into a build — the content a JavaScript build's
// registration UUID is derived from (build-id.ts).
//
// Read from the BUNDLES, not the maps. Inject writes the id into both, but the plugin deletes the
// client `.map` files once they are uploaded (privacy), so a registration that read maps would have to
// run before that deletion — an ordering constraint with a privacy failure on the wrong side of it.
// The `//# debugId=` comment in each bundle survives, so registration can run last.
import type { Dirent } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** The comment inject appends (`src/inject/mod.rs` `DEBUG_ID_COMMENT_PREFIX`). */
const PREFIX = '//# debugId=';

/** A canonical hyphenated UUID — what the CLI's `Uuid::parse_str` accepts and prints. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The extensions inject stamps (`inject_paths`: `.js`/`.cjs`/`.mjs`). */
const STAMPED = /\.[cm]?js$/;

/**
 * How much of each bundle's END is read. Inject appends the stamp LAST — a ~300-byte runtime stub,
 * then the comment — so this is generous headroom for anything another tool adds after it, and it
 * keeps a multi-megabyte chunk to one bounded read instead of the whole file.
 */
const TAIL_BYTES = 16 * 1024;

/** Same walk rules as the map-deletion pass (orchestrate.ts), for the same reason: a mis-resolved root. */
const NEVER_WALK = new Set(['node_modules', 'src', 'test', 'tests', '__tests__']);
const MAX_DEPTH = 6;

/**
 * The debug-id a bundle carries, or undefined when it was never stamped.
 *
 * Mirrors the CLI's own reader (`existing_debug_id`): the LAST stamp wins, the next 36 characters are
 * the id, and anything that does not parse as a UUID is no id at all — a hand-edited or truncated
 * comment must not become an input to the build's identity.
 */
export function readDebugId(content: string): string | undefined {
  const at = content.lastIndexOf(PREFIX);
  if (at === -1) {
    return undefined;
  }
  const token = content
    .slice(at + PREFIX.length)
    .trimStart()
    .slice(0, 36)
    .toLowerCase();
  return UUID_RE.test(token) ? token : undefined;
}

async function readTail(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Every debug-id stamped into a bundle under `dir`.
 *
 * Never throws: a missing or unreadable directory yields nothing, because the registration this feeds
 * must not fail a build over a path problem `bugsee-cli` has already reported properly. An unreadable
 * FILE is skipped for the same reason.
 */
export async function collectDebugIds(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NEVER_WALK.has(entry.name) && !entry.name.startsWith('.')) {
        ids.push(...(await collectDebugIds(full, depth + 1)));
      }
    } else if (entry.isFile() && STAMPED.test(entry.name)) {
      try {
        const id = readDebugId(await readTail(full));
        if (id !== undefined) {
          ids.push(id);
        }
      } catch {
        // Unreadable: this bundle contributes nothing, and the build is not failed for it.
      }
    }
  }
  return ids;
}
