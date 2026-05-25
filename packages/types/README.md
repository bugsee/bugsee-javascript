# @bugsee/types

Zero-dependency TS types shared across the SDK: branded ids (`AppToken`/`AccessToken`/`IssueId`/`RecordingId`), public string unions (`LogLevelName`/`SeverityName`/`IssueType`/`AttributeValue`), and the declaration-merge targets `NameServiceMapping`/`NameExtensionMapping`/`NameHookMapping`/`NameHubMapping`.

Type-only — no runtime code; validated by the type-checker via `src/index.test-d.ts`. Tier 0 (design §5).
