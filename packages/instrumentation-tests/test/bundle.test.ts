// Tests for the shared bundle-assertion library (test/bundle.ts).
//
// This library is VERIFICATION INFRASTRUCTURE, so its failure mode is the one the adversarial review
// found everywhere: an assertion that silently passes. Every assertion here therefore gets a NEGATIVE
// test proving it actually fails on the defect it exists to catch — the positive test alone would be
// exactly the theater we are removing (docs/review/e2e-harnesses.md SEV1 #3/#7/#9).
//
// The two integrity cases are modelled on REAL confirmed defects:
//   - core Pass D: a recovered crash bundle declared `profile.json` while the zip held only the
//     directory-shaped entry `profile.json/` (docs/review/core-D-bundle-upload-recovery.md).
//   - capture/node: URL query-string credentials reached the wire unredacted
//     (docs/review/capture.md, docs/review/node-B-http-server.md).
import { strToU8, zipSync } from '@bugsee/util';
import { describe, expect, it } from 'vitest';
import {
  assertBundleIntegrity,
  assertNoContractViolations,
  assertNoSecrets,
  type ParsedBundle,
  parseBundles,
  readJson,
} from './bundle';

/** Build a ParsedBundle from a plain file map, going through the real zip round-trip. */
const makeBundle = (files: Record<string, string>, issueId = 'i1'): ParsedBundle => {
  const zipped = zipSync(
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])) as Record<
      string,
      Uint8Array
    >,
  );
  const [bundle] = parseBundles({ uploads: [{ issueId, body: zipped }] });
  return bundle as ParsedBundle;
};

const manifest = (fileEntries: Array<{ filename: string; type: string }>): string =>
  JSON.stringify({
    version: 2,
    time: { start: 1, end: 2 },
    files: fileEntries,
    attrs: {},
  });

/** A well-formed bundle: request.json + manifest.json + apptoken + one declared, present file. */
const wellFormed = (extra: Record<string, string> = {}): ParsedBundle =>
  makeBundle({
    'request.json': JSON.stringify({ report: { type: 'crash' } }),
    'manifest.json': manifest([{ filename: 'logs.json', type: 'logs' }]),
    apptoken: 'token-abc',
    'logs.json': JSON.stringify([{ level: 3, text: 'hello' }]),
    ...extra,
  });

describe('parseBundles', () => {
  it('unzips each upload and exposes its files, issueId and parsed request.json', () => {
    const b = wellFormed();
    expect(b.issueId).toBe('i1');
    expect(Object.keys(b.files).sort()).toEqual([
      'apptoken',
      'logs.json',
      'manifest.json',
      'request.json',
    ]);
    expect(b.request).toEqual({ report: { type: 'crash' } });
  });

  it('parses the manifest when present', () => {
    expect(wellFormed().manifest?.files.map((f) => f.filename)).toEqual(['logs.json']);
  });

  it('leaves manifest undefined when the bundle has none, rather than throwing', () => {
    const b = makeBundle({ 'request.json': '{}' });
    expect(b.manifest).toBeUndefined();
  });

  it('preserves upload order across multiple bundles', () => {
    const zip = (name: string): Uint8Array =>
      zipSync({ 'request.json': strToU8(JSON.stringify({ n: name })) } as Record<
        string,
        Uint8Array
      >);
    const parsed = parseBundles({
      uploads: [
        { issueId: 'a', body: zip('first') },
        { issueId: 'b', body: zip('second') },
      ],
    });
    expect(parsed.map((p) => p.issueId)).toEqual(['a', 'b']);
    expect(parsed.map((p) => (p.request as { n: string }).n)).toEqual(['first', 'second']);
  });
});

describe('readJson', () => {
  it('decodes and parses a named file', () => {
    expect(readJson<Array<{ text: string }>>(wellFormed(), 'logs.json')[0]?.text).toBe('hello');
  });

  it('throws a message naming the missing file and listing what IS present', () => {
    // A silent undefined here is how "assert on a file that was never emitted" passes vacuously.
    expect(() => readJson(wellFormed(), 'nope.json')).toThrow(/nope\.json/);
    expect(() => readJson(wellFormed(), 'nope.json')).toThrow(/logs\.json/);
  });
});

describe('assertBundleIntegrity', () => {
  it('passes a well-formed bundle', () => {
    expect(() => assertBundleIntegrity(wellFormed())).not.toThrow();
  });

  // THE core Pass D defect, reproduced exactly.
  it('FAILS when the manifest declares a file the zip does not contain', () => {
    const b = makeBundle({
      'request.json': '{}',
      'manifest.json': manifest([{ filename: 'profile.json', type: 'profile' }]),
      apptoken: 't',
    });
    expect(() => assertBundleIntegrity(b)).toThrow(
      /declared in manifest but missing.*profile\.json/s,
    );
  });

  it('FAILS when the zip holds only a directory-shaped entry for a declared file', () => {
    const b = makeBundle({
      'request.json': '{}',
      'manifest.json': manifest([{ filename: 'profile.json', type: 'profile' }]),
      apptoken: 't',
      'profile.json/': '',
    });
    // Assert the SPECIFIC diagnosis, not merely that the filename appears. Matching loosely here let a
    // mutation survive that treated the `name/` entry as satisfying the declaration: the bundle then
    // failed as "empty file" instead, so the test still passed while the real check was gone.
    expect(() => assertBundleIntegrity(b)).toThrow(/directory-shaped entry "profile\.json\/"/);
    expect(() => assertBundleIntegrity(b)).toThrow(/declared in manifest but missing/);
  });

  it('FAILS when the zip contains an undeclared payload file', () => {
    const b = makeBundle({
      'request.json': '{}',
      'manifest.json': manifest([]),
      apptoken: 't',
      'orphan.json': '[]',
    });
    expect(() => assertBundleIntegrity(b)).toThrow(
      /present in zip but not declared.*orphan\.json/s,
    );
  });

  it('FAILS when a declared file is present but empty', () => {
    const b = makeBundle({
      'request.json': '{}',
      'manifest.json': manifest([{ filename: 'logs.json', type: 'logs' }]),
      apptoken: 't',
      'logs.json': '',
    });
    expect(() => assertBundleIntegrity(b)).toThrow(/empty.*logs\.json/s);
  });

  it('FAILS when required root files are absent', () => {
    expect(() => assertBundleIntegrity(makeBundle({ 'manifest.json': manifest([]) }))).toThrow(
      /request\.json/,
    );
  });

  it('does not require the always-present root files to be declared in the manifest', () => {
    // request.json / manifest.json / apptoken are structural, not inventory entries.
    expect(() => assertBundleIntegrity(wellFormed())).not.toThrow();
  });

  it('throws when there is no manifest at all, rather than passing vacuously', () => {
    expect(() => assertBundleIntegrity(makeBundle({ 'request.json': '{}' }))).toThrow(/manifest/i);
  });
});

describe('assertNoSecrets', () => {
  it('passes when no forbidden value appears anywhere in the bundle', () => {
    expect(() => assertNoSecrets(wellFormed(), ['hunter2'])).not.toThrow();
  });

  // The confirmed capture/node defect: credentials in a captured URL reach the wire.
  it('FAILS when a secret appears in a captured URL query string', () => {
    const b = wellFormed({
      'network.json': JSON.stringify([{ url: 'https://api.test/v1?api_key=hunter2' }]),
      'manifest.json': manifest([
        { filename: 'logs.json', type: 'logs' },
        { filename: 'network.json', type: 'network' },
      ]),
    });
    expect(() => assertNoSecrets(b, ['hunter2'])).toThrow(/hunter2/);
  });

  it('names the file the secret leaked into', () => {
    const b = wellFormed({
      'network.json': JSON.stringify([{ url: 'https://api.test?t=hunter2' }]),
      'manifest.json': manifest([
        { filename: 'logs.json', type: 'logs' },
        { filename: 'network.json', type: 'network' },
      ]),
    });
    expect(() => assertNoSecrets(b, ['hunter2'])).toThrow(/network\.json/);
  });

  it('searches binary files too, not only the JSON ones', () => {
    const b = wellFormed({
      'replay.bin': 'prefix-hunter2-suffix',
      'manifest.json': manifest([
        { filename: 'logs.json', type: 'logs' },
        { filename: 'replay.bin', type: 'replay' },
      ]),
    });
    expect(() => assertNoSecrets(b, ['hunter2'])).toThrow(/replay\.bin/);
  });

  it('checks every supplied secret, not just the first', () => {
    const b = wellFormed({
      'network.json': JSON.stringify([{ url: 'https://api.test?t=second-secret' }]),
      'manifest.json': manifest([
        { filename: 'logs.json', type: 'logs' },
        { filename: 'network.json', type: 'network' },
      ]),
    });
    expect(() => assertNoSecrets(b, ['absent-one', 'second-secret'])).toThrow(/second-secret/);
  });

  it('ignores the apptoken file, which legitimately contains the app token', () => {
    expect(() => assertNoSecrets(wellFormed(), ['token-abc'])).not.toThrow();
  });

  it('rejects an empty secret, which would otherwise match everything and pass vacuously', () => {
    expect(() => assertNoSecrets(wellFormed(), [''])).toThrow(/empty/i);
  });
});

describe('assertNoContractViolations', () => {
  it('passes when the collector recorded none', () => {
    expect(() => assertNoContractViolations({ violations: [] })).not.toThrow();
  });

  it('FAILS and surfaces where the violation was + what ajv said', () => {
    expect(() =>
      assertNoContractViolations({
        violations: [
          { where: 'manifest', errors: '[{"message":"must have required property files"}]' },
        ],
      }),
    ).toThrow(/manifest/);
    expect(() =>
      assertNoContractViolations({
        violations: [
          { where: 'manifest', errors: '[{"message":"must have required property files"}]' },
        ],
      }),
    ).toThrow(/required property files/);
  });

  it('reports every violation, not only the first', () => {
    let err = '';
    try {
      assertNoContractViolations({
        violations: [
          { where: 'session', errors: 'first-problem' },
          { where: 'issue', errors: 'second-problem' },
        ],
      });
    } catch (e) {
      err = String(e);
    }
    expect(err).toContain('first-problem');
    expect(err).toContain('second-problem');
    expect(err).toContain('2 upload-contract violation');
  });
});
