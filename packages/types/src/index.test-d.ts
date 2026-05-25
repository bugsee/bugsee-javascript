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
  // branded ids are string subtypes...
  Expect<Extends<AppToken, string>>,
  Expect<Extends<AccessToken, string>>,
  Expect<Extends<IssueId, string>>,
  Expect<Extends<RecordingId, string>>,
  // ...but a plain string is NOT one of them...
  Expect<Equal<Extends<string, AppToken>, false>>,
  // ...and the brands are mutually distinct.
  Expect<Equal<Extends<AppToken, IssueId>, false>>,
  Expect<Equal<Extends<AccessToken, AppToken>, false>>,
  // string unions are exact
  Expect<Equal<LogLevelName, 'error' | 'warning' | 'info' | 'debug' | 'verbose'>>,
  Expect<Equal<SeverityName, 'verylow' | 'medium' | 'high' | 'critical' | 'blocker' | 'low'>>,
  Expect<Equal<IssueType, 'bug' | 'crash' | 'error'>>,
  Expect<Equal<AttributeValue, string | number | boolean | string[]>>,
  // declaration-merge targets start empty
  Expect<Equal<keyof NameServiceMapping, never>>,
  Expect<Equal<keyof NameExtensionMapping, never>>,
  Expect<Equal<keyof NameHookMapping, never>>,
];
