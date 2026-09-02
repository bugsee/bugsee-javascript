---
'@bugsee/core': minor
'@bugsee/performance': minor
---

New `setSpanFilter` — performance spans can now be scrubbed or dropped, like every other capture stream.

Network, log, breadcrumb and report streams have had a redaction filter since the redaction slice.
Spans had none, and spans are the stream that most needs one: a consumed OpenTelemetry span reaches the
SDK with every attribute intact, so registering `@opentelemetry/instrumentation-pg` sends `db.statement`
as raw SQL with literal values in it. The same path carries GenAI prompts and completions and HTTP
bodies. There was no way to reach any of it short of not consuming OTel at all.

```ts
bugsee.setSpanFilter((span) =>
  span.attributes?.['db.statement'] === undefined
    ? span
    : { ...span, attributes: { ...span.attributes, 'db.statement': '<redacted>' } },
);
```

The filter runs for the transaction ROOT as well as every child, so a consumed span assembled as a root
is reachable too; returning `null` drops that span, and dropping the root drops the whole transaction.
It is applied at both transaction funnels — the SDK's own finished transactions and externally recorded
ones — because the continuous-upload store and the incident-bundle capture ring are separate writes, and
filtering one would ship the unscrubbed span through the other. A filter that throws drops the span and
reports once, the same rule the other filters follow: a filter that threw cannot be assumed to have
scrubbed anything.
