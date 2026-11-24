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
import path, { posix } from 'node:path';
import { parse } from 'acorn';
import { readDebugId } from './debug-ids';

/** One thing that is wrong with a stamped asset. */
export interface StampIssue {
  /** The asset, as named in the staged set (its path relative to the output root). */
  name: string;
  reason: string;
  /** The asset's source map lies outside the output: no later attempt can stamp it either. */
  outside?: true;
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
const BUNDLE = /\.[cm]?js$/i;

/** A source-map pointer comment, `//# sourceMappingURL=…` or the legacy `//@` spelling. */
const SOURCE_MAPPING_URL = /^[ \t]*\/\/[#@][ \t]*sourceMappingURL=(.*?)[ \t\r]*$/gm;

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
export function lastSourceMappingUrl(code: string): string | undefined {
  let last: string | undefined;
  for (const match of code.matchAll(SOURCE_MAPPING_URL)) {
    last = match[1];
  }
  return last;
}

/**
 * The name of the map that belongs to the bundle `name` whose text is `text`.
 *
 * The map a debugger loads is the one the bundle's `sourceMappingURL` points at, and a bundler may name it
 * anything (`sourcemapFileName(s)`, Rolldown), so the pair is resolved from the pointer, relative to the
 * bundle's directory. A pointer that is absent, remote, `data:`, root-absolute, malformed or that names a
 * file `exists` does not know falls back to the `<bundle>.map` sibling inject pairs by default.
 */
export function resolveMapName(
  name: string,
  text: string,
  exists: (candidate: string) => boolean,
  api: Pick<typeof posix, 'dirname' | 'join'> = posix,
): string {
  const candidate = localPointerTarget(name, text, api);
  return candidate !== undefined && exists(candidate) ? candidate : `${name}.map`;
}

/**
 * Where a bundle's LOCAL `sourceMappingURL` points, resolved from the bundle's directory (and
 * percent-decoded). Undefined for no pointer, a remote or `data:` one, a root-absolute one, or a malformed
 * escape. The pointer is read to the end of the line: a bundler can emit an unencoded space.
 */
export function localPointerTarget(
  name: string,
  text: string,
  api: Pick<typeof posix, 'dirname' | 'join'> = posix,
): string | undefined {
  const pointer = lastSourceMappingUrl(text);
  if (pointer === undefined || pointer === '' || /^([a-z][a-z0-9+.-]*:|\/)/i.test(pointer)) {
    return undefined;
  }
  try {
    return api.join(api.dirname(name), decodeURI(pointer));
  } catch {
    return undefined;
  }
}

/** Whether a relative path climbs out of its root (`../x`). */
const escapesRoot = (relative: string): boolean => /^\.\.([\\/]|$)/.test(relative);

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
  /** The path implementation the names follow: posix for bundler asset names, the native one for disk paths. */
  api: Pick<typeof posix, 'dirname' | 'join'> = posix,
): StampIssue[] {
  const issues: StampIssue[] = [];
  const changed = (name: string): boolean => {
    const was = before.get(name);
    const now = after.get(name);
    return was !== undefined && now !== undefined && !now.equals(was);
  };
  const ids = new Map<string, string | undefined>();
  const mapOf = new Map<string, string>();

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
    const target = localPointerTarget(name, (after.get(name) as Buffer).toString('utf8'), api);
    if (target !== undefined && escapesRoot(target)) {
      // The map is outside what is staged: inject cannot stamp it, so this bundle would carry an id that
      // never reaches its map. Refused, so the caller falls back (post-emit) or restores.
      issues.push({
        name,
        reason: `its source map (${target}) lies outside the output directory, so it cannot be stamped with the bundle. Emit the maps inside the output directory, or upload them yourself with bugsee-cli (sourcemaps inject, then debug-files upload).`,
        outside: true,
      });
    }
    mapOf.set(
      name,
      resolveMapName(name, (after.get(name) as Buffer).toString('utf8'), (n) => after.has(n), api),
    );
    for (const reason of reasons) {
      issues.push({ name, reason });
    }
  }

  // Every stamped bundle's map (changed or not) must now carry the bundle's id.
  for (const [bundle, bundleId] of ids) {
    const map = mapOf.get(bundle) as string;
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
  const pairedMaps = new Set(mapOf.values());
  // The id of an UNCHANGED bundle that already carries one, by the map it points at: a map that changed
  // must agree with it (the bundle pass skipped it because its bytes did not change).
  const unchangedIds = new Map<string, string>();
  for (const [bundle, bytes] of after) {
    if (BUNDLE.test(bundle) && before.has(bundle) && !changed(bundle)) {
      const text = bytes.toString('utf8');
      const id = readDebugId(text);
      if (id !== undefined) {
        unchangedIds.set(
          resolveMapName(bundle, text, (n) => after.has(n), api),
          id,
        );
      }
    }
  }
  for (const name of before.keys()) {
    if (name.endsWith('.map') && changed(name) && !pairedMaps.has(name)) {
      const mapId = mapDebugId(after.get(name) as Buffer);
      if (mapId === null) {
        issues.push({ name, reason: 'the stamped map is not valid JSON (an object)' });
      } else if (mapId === undefined && unchangedIds.has(name)) {
        issues.push({
          name,
          reason: `the map has no debugId (its bundle carries ${unchangedIds.get(name)})`,
        });
      } else if (
        mapId !== undefined &&
        unchangedIds.has(name) &&
        unchangedIds.get(name) !== mapId
      ) {
        issues.push({
          name,
          reason: `the map's debugId ${mapId} does not match its bundle's debugId comment ${unchangedIds.get(name)}`,
        });
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
export function verifyStampedPairs(
  files: ReadonlyMap<string, Buffer>,
  /** The build's own bundle -> map mapping, where the pointer and sibling cannot say. */
  known: ReadonlyMap<string, string> = new Map(),
): StampIssue[] {
  const issues: StampIssue[] = [];
  for (const [name, bytes] of files) {
    if (!BUNDLE.test(name)) {
      continue;
    }
    const text = bytes.toString('utf8');
    const map = known.get(name) ?? resolveMapName(name, text, (n) => files.has(n), path);
    const mapBytes = files.get(map);
    if (mapBytes === undefined) {
      continue;
    }
    const bundleId = readDebugId(text);
    const mapId = mapDebugId(mapBytes);
    if (mapId === null) {
      issues.push({ name: map, reason: 'the map is not valid JSON (an object)' });
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
        name: map,
        reason: `the map has no debugId (its bundle carries ${bundleId})`,
      });
    } else if (mapId !== bundleId) {
      issues.push({
        name: map,
        reason: `the map's debugId ${mapId} does not match its bundle's debugId comment ${bundleId}`,
      });
    }
  }
  return issues;
}
