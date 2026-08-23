// Guards `packages/protocol/upload-contract.schema.json` against drifting from the TypeScript wire
// contract it mirrors.
//
// The schema is a hand-written JSON Schema (the same approach @bugsee/webview takes with
// bridge-protocol.schema.json). Hand-written means it CAN drift from wire.ts/constants.ts — and a schema
// that has silently drifted is worse than none, because it validates the wrong contract while looking
// authoritative. These tests pin every enum in the schema to its TS union, so adding a FileType or a
// RuntimeType without updating the schema fails here rather than in production.
//
// Introduced with Wave V0 (docs/review/REMEDIATION-PLAN.md): the adversarial review found the e2e mock
// collector "validates nothing — it is a byte sink, not a contract" (docs/review/e2e-harnesses.md SEV1
// #7), which is how wire defects such as the never-called logLevelToWire survived e2e.
import { describe, expect, it } from 'vitest';
import schema from '../upload-contract.schema.json' with { type: 'json' };
import { DEFAULT_FILENAMES } from './constants';
import { Severity } from './levels';

/** Enum values declared at a JSON-pointer-ish path in the schema. */
const enumAt = (path: string[]): string[] => {
  let node: unknown = schema;
  for (const key of path) node = (node as Record<string, unknown>)[key];
  return (node as { enum: string[] }).enum;
};

describe('upload-contract.schema.json ↔ TypeScript wire contract', () => {
  it('declares every FileType the SDK can emit', () => {
    // DEFAULT_FILENAMES is keyed by every FileType except 'attachment' (which has no default name),
    // so it is the runtime-visible source of truth for the union.
    const fromCode = [...Object.keys(DEFAULT_FILENAMES), 'attachment'].sort();
    const fromSchema = [
      ...enumAt([
        'definitions',
        'manifestJson',
        'properties',
        'files',
        'items',
        'properties',
        'type',
      ]),
    ].sort();
    expect(fromSchema).toEqual(fromCode);
  });

  it('covers the full numeric Severity range', () => {
    const numeric = Object.values(Severity).filter((v): v is number => typeof v === 'number');
    const sev = (
      schema.definitions.requestJson.properties as {
        severity: { minimum: number; maximum: number };
      }
    ).severity;
    expect(sev.minimum).toBe(Math.min(...numeric));
    expect(sev.maximum).toBe(Math.max(...numeric));
  });

  it('requires sdk.type to be exactly "javascript" — the backend JS discriminator', () => {
    // worker/jobs/bundle.py routes JS crashes on this value; a loosened schema would stop protecting it
    // (docs/review/protocol.md finding 3).
    expect(schema.definitions.environmentEnvelope.properties.sdk.properties.type.const).toBe(
      'javascript',
    );
  });

  it('requires the runtime block — every tier fills it, so a missing one is a defect', () => {
    expect(schema.definitions.environmentEnvelope.required).toContain('runtime');
    expect(schema.definitions.environmentEnvelope.properties.runtime.required).toEqual([
      'type',
      'version',
    ]);
  });

  it('leaves platform.type OPEN, because it is an OS name and not an SDK-side enum', () => {
    // The host tiers report the OS ('macos'/'linux'/'windows' — the set bugsee-rust reports), and node
    // can name OSes beyond those three. Enumerating them here would reject a legitimate host rather
    // than catch a defect; the enum that must stay closed is the runtime one below.
    const platformType = schema.definitions.environmentEnvelope.properties.platform.properties
      .type as { type: string; minLength: number; enum?: unknown };
    expect(platformType.type).toBe('string');
    expect(platformType.enum).toBeUndefined();
    expect(platformType.minLength).toBe(1); // but never blank — the backend rejects a session without it
  });

  it('lists the RUNTIME types the SDK actually reports', () => {
    // Pinned explicitly: these are the values docs/design/sdk-design.md §8.6 defines, and a new runtime
    // must be added here deliberately.
    expect([...enumAt(['definitions', 'runtimeType'])].sort()).toEqual(
      [
        'web',
        'node',
        'bun',
        'deno',
        'workers',
        'edge-light',
        'service-worker',
        'web-worker',
        'electron-main',
        'electron-renderer',
      ].sort(),
    );
  });

  it('lists every report mechanism', () => {
    expect([...enumAt(['definitions', 'mechanism'])].sort()).toEqual(
      [
        'programmatic',
        'uncaught',
        'unhandledrejection',
        'console-error',
        'http-error',
        'hang',
        'snapshot',
        'manual-dialog',
      ].sort(),
    );
  });

  it('rejects all-zero W3C ids, which are invalid per the spec', () => {
    const props = schema.definitions.requestJson.properties as {
      trace_id: { not: { const: string } };
      span_id: { not: { const: string } };
    };
    expect(props.trace_id.not.const).toBe('0'.repeat(32));
    expect(props.span_id.not.const).toBe('0'.repeat(16));
  });
});
