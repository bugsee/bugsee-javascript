// Check what `bugsee-cli sourcemaps inject` did, before the result is trusted.
//
// Stamping rewrites the user's shipped JavaScript. The Rust inject is well tested, but "well tested"
// is not "verified on THIS build": a bundle with an unusual tail, a map that is not what its
// extension says, or a future inject regression would otherwise ship a script that no longer parses
// (a blank page) or a map whose id does not match its bundle (a crash that silently never
// symbolicates). Both are cheap to rule out on the bytes in hand, and expensive to find in production.
//
// Pure: it takes the bytes from before and after and returns what is wrong. What to DO about it
// (leave the asset alone in-build, restore the file after emit) is the caller's.
import { parse } from 'acorn';
import { readDebugId } from './debug-ids';

/** One thing that is wrong with a stamped asset. */
export interface StampIssue {
  /** The asset, as named in the staged set (its path relative to the output root). */
  name: string;
  reason: string;
}

/** The first few issues as one line, for an error message. */
export function formatIssues(issues: readonly StampIssue[]): string {
  return (
    issues
      .slice(0, 3)
      .map((issue) => `${issue.name}: ${issue.reason}`)
      .join('; ') + (issues.length > 3 ? `; and ${issues.length - 3} more` : '')
  );
}

/** What inject stamps (`.js`/`.cjs`/`.mjs`); the map of `x.js` is `x.js.map`. */
const BUNDLE = /\.[cm]?js$/;

/** A source-map pointer comment, `//# sourceMappingURL=…` or the legacy `//@` spelling. */
const SOURCE_MAPPING_URL = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=(\S*)[ \t]*$/gm;

/**
 * Whether `code` is syntactically valid JavaScript, as a module or as a classic script.
 *
 * Tried as a module first (an ES bundle has `import`/`export`), then as a script, because the two
 * grammars differ (`with`, octal escapes and a bare `await` identifier are script-only). Return and
 * top-level await are allowed so a CommonJS wrapper body and a worker entry are not false alarms.
 */
export function parseScript(code: string): boolean {
  for (const sourceType of ['module', 'script'] as const) {
    try {
      parse(code, {
        ecmaVersion: 'latest',
        sourceType,
        allowHashBang: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
      });
      return true;
    } catch {
      // try the other grammar
    }
  }
  return false;
}

/** The value of the LAST sourceMappingURL comment in `code` — the one a debugger honours. */
function lastSourceMappingUrl(code: string): string | undefined {
  let last: string | undefined;
  for (const match of code.matchAll(SOURCE_MAPPING_URL)) {
    last = match[1];
  }
  return last;
}

/** Reasons a changed bundle is not a faithful stamp of `before`. */
function bundleIssues(
  before: Buffer,
  after: Buffer,
  parser: (code: string) => boolean,
): { reasons: string[]; id: string | undefined } {
  const reasons: string[] = [];
  const beforeText = before.toString('utf8');
  const afterText = after.toString('utf8');

  // (i) Still parses. Judged against the original: a bundle the parser could not read to begin with
  // (syntax newer than it knows) says nothing about the stamp, and must not block the build.
  if (!parser(afterText) && parser(beforeText)) {
    reasons.push('no longer parses as JavaScript after stamping');
  }

  // (iv) Nothing but an appended stamp. A bundle that was ALREADY stamped is re-stamped in place (the
  // old stamp is replaced, not extended), so only a first stamp can be held to "bytes appended".
  if (readDebugId(beforeText) === undefined && !after.subarray(0, before.length).equals(before)) {
    reasons.push('the original bytes were altered, not just appended to');
  }

  // (ii) The map pointer survived untouched. Inject appends AFTER it (measured, bugsee-cli 0.9.0: the
  // runtime stub and the debugId comment follow the sourceMappingURL line), so "still last" would be
  // wrong; what must hold is that the comment a debugger resolves is the same one.
  const pointer = lastSourceMappingUrl(beforeText);
  if (pointer !== undefined && lastSourceMappingUrl(afterText) !== pointer) {
    reasons.push(`the sourceMappingURL comment (${pointer}) was lost or changed by stamping`);
  }

  const id = readDebugId(afterText);
  if (id === undefined) {
    reasons.push('no debugId comment after stamping');
  }
  return { reasons, id };
}

/** The `debugId` of a source map's JSON, `null` when it is not a JSON object, `undefined` when it has none. */
function mapDebugId(bytes: Buffer): string | null | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const id = (parsed as { debugId?: unknown }).debugId;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * Verify a stamp. `before` / `after` map each asset name to its bytes; only assets that DIFFER are
 * examined (inject leaves the rest untouched), so `after` may simply be the whole post-inject set.
 *
 * - every changed bundle still parses, keeps its sourceMappingURL comment, carries a debugId comment,
 *   and (unless it was already stamped) is the original with bytes appended;
 * - every changed map is a JSON object, and the map of a changed bundle carries a `debugId` equal to
 *   the bundle's comment.
 */
export function verifyStamp(
  before: ReadonlyMap<string, Buffer>,
  after: ReadonlyMap<string, Buffer>,
  parser: (code: string) => boolean = parseScript,
): StampIssue[] {
  const issues: StampIssue[] = [];
  const changed = (name: string): boolean => {
    const was = before.get(name);
    const now = after.get(name);
    return was !== undefined && now !== undefined && !now.equals(was);
  };
  const ids = new Map<string, string | undefined>();

  for (const name of before.keys()) {
    if (!BUNDLE.test(name) || !changed(name)) {
      continue;
    }
    const { reasons, id } = bundleIssues(
      before.get(name) as Buffer,
      after.get(name) as Buffer,
      parser,
    );
    ids.set(name, id);
    for (const reason of reasons) {
      issues.push({ name, reason });
    }
  }

  // Every stamped bundle's map (changed or not) must now carry the bundle's id.
  for (const [bundle, bundleId] of ids) {
    const map = `${bundle}.map`;
    const bytes = after.get(map);
    if (bytes === undefined) {
      continue; // a bundle with no map: nothing to symbolicate against, nothing to match
    }
    const mapId = mapDebugId(bytes);
    if (mapId === null) {
      issues.push({ name: map, reason: 'the stamped map is not valid JSON (an object)' });
    } else if (mapId === undefined) {
      issues.push({ name: map, reason: 'the stamped map has no debugId' });
    } else if (bundleId !== undefined && mapId !== bundleId) {
      issues.push({
        name: map,
        reason: `the map's debugId ${mapId} does not match its bundle's debugId comment ${bundleId}`,
      });
    }
  }

  // A changed map whose bundle was not stamped in this run: only held to being a JSON object.
  for (const name of before.keys()) {
    if (name.endsWith('.map') && changed(name) && !ids.has(name.slice(0, -'.map'.length))) {
      if (mapDebugId(after.get(name) as Buffer) === null) {
        issues.push({ name, reason: 'the stamped map is not valid JSON (an object)' });
      }
    }
  }
  return issues;
}

/**
 * Check a build AS IT IS ON DISK, with no "before" to compare against — what the in-build path can
 * still verify once the bundler has written its output.
 *
 * Stamping in memory is only as good as what happens to the bytes afterwards: Vite, for one, rewrites
 * a chunk's code and REGENERATES its `.map` asset after a `generateBundle` hook has run (its
 * dynamic-import preload substitution), which can drop a debugId the stamp put in the map. A bundle with a
 * map must carry a debugId comment, and the map the SAME id, or the build ships bytes that look stamped
 * and cannot be symbolicated. Bundles without a map are left alone (nothing to match).
 */
export function verifyStampedPairs(files: ReadonlyMap<string, Buffer>): StampIssue[] {
  const issues: StampIssue[] = [];
  for (const [name, bytes] of files) {
    const mapBytes = files.get(`${name}.map`);
    if (!BUNDLE.test(name) || mapBytes === undefined) {
      continue;
    }
    const bundleId = readDebugId(bytes.toString('utf8'));
    const mapId = mapDebugId(mapBytes);
    if (mapId === null) {
      issues.push({ name: `${name}.map`, reason: 'the map is not valid JSON (an object)' });
    } else if (bundleId === undefined && mapId === undefined) {
      issues.push({
        name,
        reason: 'the bundle was not stamped (no debugId comment, and its map has none)',
      });
    } else if (bundleId === undefined) {
      issues.push({
        name,
        reason: `the bundle lost its debugId comment (its map carries ${mapId})`,
      });
    } else if (mapId === undefined) {
      issues.push({
        name: `${name}.map`,
        reason: `the map has no debugId (its bundle carries ${bundleId})`,
      });
    } else if (mapId !== bundleId) {
      issues.push({
        name: `${name}.map`,
        reason: `the map's debugId ${mapId} does not match its bundle's debugId comment ${bundleId}`,
      });
    }
  }
  return issues;
}
