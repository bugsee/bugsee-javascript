// @bugsee/types — zero-dependency TS types shared across the SDK (design §5, §8.9, §10).
// Type-only: no runtime code. Validated by the type-checker via src/index.test-d.ts.

declare const brand: unique symbol;

/** Nominal/branded type: an opaque `T` that can't be mixed with plain `T` or other brands. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

// ── Branded identifiers (design §10) ────────────────────────────────────────
export type AppToken = Brand<string, 'AppToken'>;
export type AccessToken = Brand<string, 'AccessToken'>;
export type IssueId = Brand<string, 'IssueId'>;
export type RecordingId = Brand<string, 'RecordingId'>;

// ── Public string unions (string-typed API surface; numeric wire maps live in
//    @bugsee/protocol — design §8.9). ─────────────────────────────────────────
export type LogLevelName = 'error' | 'warning' | 'info' | 'debug' | 'verbose';
/** `low` is the iOS alias for `verylow`, kept for cross-platform parity (design §8.9). */
export type SeverityName = 'verylow' | 'medium' | 'high' | 'critical' | 'blocker' | 'low';
export type IssueType = 'bug' | 'crash' | 'error';
export type AttributeValue = string | number | boolean | string[];

// ── Cross-package declaration-merge targets (design §5.2, §16.3) ─────────────
// Start empty; each owning package augments these via `declare module '@bugsee/types'`.
// biome-ignore lint/suspicious/noEmptyInterface: declaration-merge targets are intentionally empty.
export interface NameServiceMapping {}
// biome-ignore lint/suspicious/noEmptyInterface: declaration-merge targets are intentionally empty.
export interface NameExtensionMapping {}
// biome-ignore lint/suspicious/noEmptyInterface: declaration-merge targets are intentionally empty.
export interface NameHookMapping {}
