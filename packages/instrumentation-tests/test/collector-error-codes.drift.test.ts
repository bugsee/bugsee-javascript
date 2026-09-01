import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SERVER_ERROR_CATEGORIES, type ServerErrorCategory } from '@bugsee/core';
import { describe, expect, it } from 'vitest';

// DRIFT TEST. The collector's error-code table is Android-canonical, and this SDK transcribes it by
// hand. That transcription had no independent reader: the invariants harness copied the SAME Java table
// as its expected answers, so a mistake made in both places produced 350 passing cases and no violation.
// The cost is not hypothetical — classifying 99013 (ServerTooBusy) as permanent would delete crash
// reports at exactly the moment the collector is shedding load.
//
// So the check is against the Java SOURCE, not against another copy of it. When the Android checkout is
// not present (CI, a fresh clone) this skips rather than fails: it is a drift detector, not a gate that
// can be satisfied by guessing.

const JAVA = fileURLToPath(
  new URL(
    '../../../../android/sdk/library/src/main/java/com/bugsee/library/communication/CommunicationErrorClassifier.java',
    import.meta.url,
  ),
);

const JAVA_TO_TS: Readonly<Record<string, ServerErrorCategory>> = {
  TRANSIENT: 'transient',
  PERMANENT: 'permanent',
  AUTH_EXPIRED: 'auth_expired',
  KILL_SDK: 'kill_sdk',
};

/** The `classifyServerErrorCode` switch, as a code → category map plus its `default` arm. */
function parseJava(source: string): {
  table: Record<number, ServerErrorCategory>;
  fallback: string;
} {
  const start = source.indexOf('ErrorCategory classifyServerErrorCode');
  expect(start, 'classifyServerErrorCode not found in the Java source').toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('\n    }', start));

  const table: Record<number, ServerErrorCategory> = {};
  let pending: number[] = [];
  let fallback = '';
  let seenDefault = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    const caseMatch = /^case\s+(\d+)\s*:/.exec(line);
    if (caseMatch?.[1] !== undefined) {
      pending.push(Number(caseMatch[1]));
      continue;
    }
    if (line.startsWith('default:')) {
      seenDefault = true;
      continue;
    }
    const returnMatch = /^return\s+ErrorCategory\.(\w+)\s*;/.exec(line);
    if (returnMatch?.[1] === undefined) {
      continue;
    }
    const category = JAVA_TO_TS[returnMatch[1]];
    expect(category, `unmapped Java ErrorCategory.${returnMatch[1]}`).toBeDefined();
    if (seenDefault) {
      fallback = returnMatch[1];
      seenDefault = false;
      continue;
    }
    for (const code of pending) {
      table[code] = category as ServerErrorCategory;
    }
    pending = [];
  }
  return { table, fallback };
}

describe.skipIf(!existsSync(JAVA))('collector error codes match the Android source', () => {
  const { table, fallback } = parseJava(readFileSync(JAVA, 'utf8'));

  it('parsed a non-trivial table (the parser itself is not silently matching nothing)', () => {
    // Without this, a parser that returned {} would make every comparison below vacuously true — the
    // exact failure mode this whole test exists to close.
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(9);
    expect(new Set(Object.values(table)).size).toBeGreaterThanOrEqual(3);
  });

  it('classifies every code Android classifies, identically', () => {
    expect(SERVER_ERROR_CATEGORIES).toEqual(table);
  });

  it('falls back to TRANSIENT on an unknown code, as Android does', () => {
    // The safe direction: an unrecognised code costs a retry, never an incident.
    expect(fallback).toBe('TRANSIENT');
  });
});
