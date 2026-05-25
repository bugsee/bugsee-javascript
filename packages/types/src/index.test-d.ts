// Type-level tests for @bugsee/types, checked by `tsc --noEmit` (the type-checker is the test
// runner for a type-only package). Each entry must resolve to `true`; a wrong type makes the
// corresponding `Expect<...>` resolve to `Expect<false>`, which is a compile error.

import type {
  AccessToken,
  AppToken,
  AttributeValue,
  IssueId,
  IssueType,
  LogLevelName,
  NameExtensionMapping,
  NameHookMapping,
  NameHubMapping,
  NameServiceMapping,
  RecordingId,
  SeverityName,
} from './index';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// Exported so the assertions are "used" (no unused-symbol diagnostics) and evaluated by tsc.
export type TypeAssertions = [
  // each brand is a string subtype...
  Expect<Extends<AppToken, string>>,
  Expect<Extends<AccessToken, string>>,
  Expect<Extends<IssueId, string>>,
  Expect<Extends<RecordingId, string>>,
  // ...but plain string is assignable to NONE of them...
  Expect<Equal<Extends<string, AppToken>, false>>,
  Expect<Equal<Extends<string, AccessToken>, false>>,
  Expect<Equal<Extends<string, IssueId>, false>>,
  Expect<Equal<Extends<string, RecordingId>, false>>,
  // ...and the brands are mutually non-assignable (every ordered distinct pair).
  Expect<Equal<Extends<AppToken, AccessToken>, false>>,
  Expect<Equal<Extends<AppToken, IssueId>, false>>,
  Expect<Equal<Extends<AppToken, RecordingId>, false>>,
  Expect<Equal<Extends<AccessToken, AppToken>, false>>,
  Expect<Equal<Extends<AccessToken, IssueId>, false>>,
  Expect<Equal<Extends<AccessToken, RecordingId>, false>>,
  Expect<Equal<Extends<IssueId, AppToken>, false>>,
  Expect<Equal<Extends<IssueId, AccessToken>, false>>,
  Expect<Equal<Extends<IssueId, RecordingId>, false>>,
  Expect<Equal<Extends<RecordingId, AppToken>, false>>,
  Expect<Equal<Extends<RecordingId, AccessToken>, false>>,
  Expect<Equal<Extends<RecordingId, IssueId>, false>>,
  // string unions are exact
  Expect<Equal<LogLevelName, 'error' | 'warning' | 'info' | 'debug' | 'verbose'>>,
  Expect<Equal<SeverityName, 'verylow' | 'medium' | 'high' | 'critical' | 'blocker' | 'low'>>,
  Expect<Equal<IssueType, 'bug' | 'crash' | 'error'>>,
  Expect<Equal<AttributeValue, string | number | boolean | string[]>>,
  // declaration-merge targets start empty
  Expect<Equal<keyof NameServiceMapping, never>>,
  Expect<Equal<keyof NameExtensionMapping, never>>,
  Expect<Equal<keyof NameHookMapping, never>>,
  Expect<Equal<keyof NameHubMapping, never>>,
];
