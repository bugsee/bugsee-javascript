---
'@bugsee/performance': minor
---

Database, GenAI, GraphQL and HTTP span attributes are now scrubbed by default.

Consuming OpenTelemetry brings in whole categories of data the SDK never produced:
`@opentelemetry/instrumentation-pg` puts executed SQL on `db.statement` with the literal values still
in it, the GenAI conventions carry prompts and completions verbatim, and HTTP instrumentation can carry
bodies. Peer SDKs default all of that on, in the clear. This one captures it — scrubbed on the way in.

- **Database statements keep their SHAPE and lose their data.**
  `SELECT * FROM users WHERE email = 'a@b.com'` becomes `SELECT * FROM users WHERE email = ?`, which is
  the form that is actually useful: every execution of one query looks the same, so it groups, and it
  carries nothing about a customer. SQL's own doubled-quote escape is consumed as part of the string it
  sits in, so `'O''Brien'` is one literal rather than a terminator followed by a name.
- **Free-form content is redacted outright** — `gen_ai.prompt`, `gen_ai.completion`, `graphql.document`,
  `graphql.variables`, `http.request.body` and friends. Unlike a query there is no shape worth keeping,
  and a prompt is whatever the user typed.
- **Everything else goes through the SDK's single definition of a sensitive key**, the same predicate
  that redacts headers and query params, matched on the attribute's leaf name: `db.user` is an
  identifier worth keeping, `db.password` is not.

An integrator `setSpanFilter` REPLACES the built-in rather than layering over it — the same XOR the
network sanitizer follows, because someone who has written a filter has decided what leaves their
process. It can also be turned off with `sanitizeSpans: false`.

A transaction the sanitizer did not change is returned by reference, so running on every transaction
costs no allocation.
