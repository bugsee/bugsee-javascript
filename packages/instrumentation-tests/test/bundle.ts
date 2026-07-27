// Shared bundle-assertion library for the e2e harnesses (Wave V0 of docs/review/REMEDIATION-PLAN.md).
//
// WHY THIS EXISTS. The adversarial review found ~90 SEV1s that survived ~100% unit coverage, and
// root-caused a large share of them to harnesses that assert a bundle ARRIVED rather than what is IN it
// (docs/review/e2e-harnesses.md SEV1 #3/#9). Each helper here is aimed at a defect class the review
// actually confirmed:
//
//   assertBundleIntegrity → core Pass D: a recovered crash bundle declared `profile.json` in its manifest
//                           while the zip held only the directory-shaped entry `profile.json/`. Backend
//                           ingestion of the WHOLE bundle can fail on that, and no test saw it.
//   assertNoSecrets       → capture/node: URL query strings and `user:pass@` credentials reached the wire
//                           unredacted; the WebView bridge streamed un-redacted capture. A leak is only
//                           detectable by scanning the real emitted bytes.
//   readJson              → asserting on a file that was never emitted must FAIL, not read `undefined`.
//
// Kept in `test/` (not `src/`) because this package ships nothing; it is harness code. It has its own
// unit tests (bundle.test.ts) which run in the fast `pnpm test` gate — an assertion library that cannot
// fail is precisely the theater this work removes, so every assertion has a negative test.
import type { ManifestJson } from '@bugsee/protocol';
import { strFromU8, unzipSync } from '@bugsee/util';

/** The subset of the mock collector this library needs — keeps it usable from every harness. */
export interface UploadsSource {
  uploads: Array<{ issueId: string; body: Uint8Array }>;
}

export interface ParsedBundle {
  issueId: string;
  /** Every entry in the uploaded zip, by name. */
  files: Record<string, Uint8Array>;
  /** Parsed `request.json` (the report envelope). */
  request: unknown;
  /** Parsed `manifest.json`, or undefined when the bundle carries none. */
  manifest?: ManifestJson;
}

/**
 * Root files that are structural rather than manifest inventory entries: they are always written by the
 * assembler and are deliberately NOT listed in `manifest.files`, so the undeclared-file check must
 * exempt them (packages/core/src/bundle-assembler.ts).
 */
const STRUCTURAL_FILES = new Set(['request.json', 'manifest.json', 'apptoken']);

const parseMaybe = <T>(bytes: Uint8Array | undefined): T | undefined =>
  bytes === undefined ? undefined : (JSON.parse(strFromU8(bytes)) as T);

/** Unzip every captured upload and parse its root JSON files, preserving arrival order. */
export function parseBundles(source: UploadsSource): ParsedBundle[] {
  return source.uploads.map((u) => {
    const files = unzipSync(u.body) as Record<string, Uint8Array>;
    return {
      issueId: u.issueId,
      files,
      request: parseMaybe<unknown>(files['request.json']),
      manifest: parseMaybe<ManifestJson>(files['manifest.json']),
    };
  });
}

/**
 * Read and JSON-parse a named file. Throws — naming the file and listing what IS present — rather than
 * returning undefined, so a test that asserts on a never-emitted file fails loudly instead of vacuously.
 */
export function readJson<T>(bundle: ParsedBundle, filename: string): T {
  const bytes = bundle.files[filename];
  if (bytes === undefined) {
    const present = Object.keys(bundle.files).sort().join(', ');
    throw new Error(`bundle ${bundle.issueId}: no file "${filename}". Present: ${present}`);
  }
  return JSON.parse(strFromU8(bytes)) as T;
}

/**
 * Assert the bundle is internally consistent — the check that would have caught the core Pass D defect.
 *
 * Verifies: the structural root files exist; a manifest is present (a bundle without one cannot be
 * validated, so that is a failure, not a pass); every file the manifest declares is present in the zip
 * as a real, non-empty entry (a directory-shaped `name/` entry does NOT satisfy a declaration); and
 * every payload entry in the zip is declared by the manifest.
 */
export function assertBundleIntegrity(bundle: ParsedBundle): void {
  const problems: string[] = [];

  for (const required of ['request.json', 'manifest.json']) {
    if (bundle.files[required] === undefined) problems.push(`missing root file: ${required}`);
  }
  if (bundle.manifest === undefined) {
    problems.push('no manifest.json — bundle integrity cannot be verified');
    throw new Error(`bundle ${bundle.issueId} integrity:\n  - ${problems.join('\n  - ')}`);
  }

  const declared = new Set<string>();
  for (const entry of bundle.manifest.files ?? []) {
    declared.add(entry.filename);
    const bytes = bundle.files[entry.filename];
    if (bytes === undefined) {
      // The zip may still hold a directory-shaped entry of the same name — call that out explicitly,
      // because it is the exact shape of the confirmed defect.
      const dirShaped = bundle.files[`${entry.filename}/`] !== undefined;
      problems.push(
        dirShaped
          ? `declared in manifest but missing (zip has only the directory-shaped entry "${entry.filename}/"): ${entry.filename}`
          : `declared in manifest but missing from zip: ${entry.filename}`,
      );
      continue;
    }
    if (bytes.length === 0) problems.push(`declared file is empty: ${entry.filename}`);
  }

  for (const name of Object.keys(bundle.files)) {
    if (STRUCTURAL_FILES.has(name) || name.endsWith('/')) continue;
    if (!declared.has(name)) problems.push(`present in zip but not declared in manifest: ${name}`);
  }

  if (problems.length > 0) {
    throw new Error(`bundle ${bundle.issueId} integrity:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Minimal shape of the collector's recorded contract violations (see test/collector.ts). */
export interface ViolationSource {
  violations: Array<{ where: string; errors: string }>;
}

/**
 * Assert the collector observed no schema violations.
 *
 * The mock collector validates every session/issue envelope and every bundle's `manifest.json` +
 * `request.json` against `packages/protocol/upload-contract.schema.json`, but it RECORDS rather than
 * rejects so a contract break surfaces as a readable assertion instead of an opaque mid-scenario upload
 * error. Nothing enforces that unless a test calls this — a recorded-but-unasserted violation would be
 * the same false assurance the review found everywhere.
 */
export function assertNoContractViolations(source: ViolationSource): void {
  if (source.violations.length === 0) return;
  const detail = source.violations.map((v) => `[${v.where}] ${v.errors}`).join('\n\n');
  throw new Error(
    `collector recorded ${source.violations.length} upload-contract violation(s):\n${detail}`,
  );
}

/**
 * Assert that none of `secrets` appears anywhere in the bundle's bytes.
 *
 * Scans EVERY entry (including binary ones such as `replay.bin`) because a leak's whole nature is
 * appearing where nobody looked. `apptoken` is exempt: it legitimately contains the app token.
 *
 * An empty secret is rejected — it would match every file and turn this into a no-op that always passes.
 */
export function assertNoSecrets(bundle: ParsedBundle, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret === '') {
      throw new Error('assertNoSecrets: empty secret would match everything — pass real values');
    }
  }

  const leaks: string[] = [];
  for (const [name, bytes] of Object.entries(bundle.files)) {
    if (name === 'apptoken' || name.endsWith('/')) continue;
    // Decode leniently: binary payloads still surface ASCII substrings, which is what a leak looks like.
    let text: string;
    try {
      text = strFromU8(bytes);
    } catch {
      text = Buffer.from(bytes).toString('latin1');
    }
    for (const secret of secrets) {
      if (text.includes(secret)) leaks.push(`"${secret}" found in ${name}`);
    }
  }

  if (leaks.length > 0) {
    throw new Error(`bundle ${bundle.issueId} leaked secrets:\n  - ${leaks.join('\n  - ')}`);
  }
}
