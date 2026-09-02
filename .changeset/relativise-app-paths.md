---
'@bugsee/core': minor
'@bugsee/node': minor
---

Application stack frames now ship relative to the app root, not as absolute filesystem paths.

The other half of the frame-path leak. Dependency frames already truncate at `node_modules`, but
application frames had no such landmark, so a Node stack carried the OS username, the home-directory
layout and often an internal project codename:

```
before  /Users/jane.doe/work/acme-secret/src/checkout.js
after   ./src/checkout.js
```

The node tier tells core where the project starts (`process.cwd()` by default, overridable with
`appRoot`; pass `''` to keep absolute paths). A working directory that has been deleted out from under
the process is survivable — the frames simply stay absolute rather than the launch failing.

Scrubbed at PARSE time rather than in the crash path, because a parsed stack reaches the wire from more
than one place: `console.trace` appends a formatted stack into the log message, so a crash-only fix
would have left `logs.json` carrying the same absolute paths.

Both sides of the source-map join go through the same scrubbing, so debug-ID matching is unaffected.
