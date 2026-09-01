---
'@bugsee/core': minor
---

Stack frames no longer ship the customer's absolute filesystem paths.

A Node crash frame carried the full path — the OS username, the home-directory layout, and often an
internal project codename — in every report, against the SDK's own rule that privacy-relevant data is
obscured to the maximum extent possible by default. A dependency frame now truncates at the **first**
`/node_modules/` boundary:

```
before  /Users/jane.doe/work/acme/node_modules/express/lib/router/index.js
after   node_modules/express/lib/router/index.js
```

The first boundary, not the last, and that is load-bearing rather than cosmetic: `file` is the key of the
`file → debugId` source-map join, so two distinct files scrubbing to one string would hand a frame the
wrong debug id and symbolicate it against the wrong map. Measured over a real 24,591-file pnpm tree,
truncating at the last boundary collapsed 2,783 distinct files onto shared keys; at the first, none. It
also keeps a nested copy distinguishable from a hoisted one, and preserves pnpm's `.pnpm/<pkg>@<version>/`
directory, so the package version survives in the frame for free.

URLs are untouched — a browser frame has no filesystem to leak and its origin is the useful part.

**Not yet covered:** application code outside `node_modules` still ships an absolute path. Relativising it
needs the app root injected from the platform, which is a separate change.
