---
'@bugsee/core': minor
'@bugsee/node': minor
---

New opt-in `captureSourceContext`: the line that threw, plus a window either side, on the crash's frames.

```ts
Bugsee.launch(token, { captureSourceContext: true });
```

Only APPLICATION frames are read. After the frame-path scrubbing in this release a dependency frame
reads `node_modules/express/lib/router/index.js` and does not resolve on disk — and reading a
dependency's source is neither useful in a report nor something an SDK should be doing, so the privacy
fix and the right behaviour here happen to be the same thing. Files are read once each and cached,
failures included, since a file that cannot be read will not become readable within a process.

When the file resolves but the line number does not point into it — the normal outcome for a stack that
has been through a build — the frame is left alone. Attaching whatever happens to sit at that offset
would point a reader at unrelated code with full confidence, which is worse than attaching nothing.

**Off by default**, unlike peer SDKs which default this on. A stack trace already ships a file and a
line number, but a line number is a *reference* and a line is the thing itself: this uploads the
customer's own source code. Under this SDK's rule that privacy-relevant data is obscured by default,
that is the customer's call rather than ours.

Core gains `composeFrameEnrichers`, so the source context and the (separately opt-in) local variables
chain in one pass, each enricher seeing what the previous added.
