---
'@bugsee/core': minor
'@bugsee/node': minor
---

New opt-in `captureLocalVariables`: the values in scope at the moment of the throw, on the crash's frames.

"It threw" becomes "it threw with `orderId=null`" — the single biggest step-change a crash report can
carry, and the one thing a stack trace fundamentally cannot tell you.

```ts
Bugsee.launch(token, { captureLocalVariables: true });
```

**Off by default, on two independent counts.**

*Cost.* Enabling V8's debugger costs ~3% steady-state (measured on Node 24, best-of-7 after warm-up).
Pausing on CAUGHT exceptions as well costs **~36 µs per throw**, which an application using exceptions
for control flow would pay continuously — so that is a second opt-in, `{ includeCaught: true }`, and the
default pauses on uncaught only.

*Privacy.* Locals hold whatever the code held. Variable names are matched against the SDK's single
definition of a sensitive key — the same predicate that redacts headers and query params — so `password`
and `accessToken` arrive as `<redacted>`, and values are truncated. But a variable called `row` can
still hold a customer record, which is why this is opt-in rather than a default with an escape hatch.

Values are rendered from V8's own description and never by calling into application code: a `toString`
can throw, and it can have side effects. Capture is capped by frames, variables per frame, value length,
and number of cached exceptions.

Core gains a runtime-portable `enrichFrames` seam (the inspector is node-only) which runs for each
exception in a `cause` chain, not just the outermost — the frames that matter are usually the original
cause's.
