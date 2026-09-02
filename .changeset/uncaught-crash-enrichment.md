---
'@bugsee/node': patch
---

Fixes local variables and source context never appearing on an **uncaught** crash.

The uncaught-exception and unhandled-rejection detection providers build their own `crash.json` and
never pass through `logException`, so a frame enricher configured on the client was silently skipped
for every uncaught crash — which is the case local variables exist for. A caught-and-reported error was
enriched; a real crash was not.

Found by an end-to-end run against a real process and a real `node:inspector`. The unit suites could
not see it: they drive `logException`, which does go through the client.

Also fixes a second interaction, from the same run: application frames now ship relative (`./src/app.js`)
after the path-privacy fix, and the source-context reader accepted only absolute paths — so context
silently stopped resolving for exactly the application files it exists for. Relative frames are now
resolved against the app root.
