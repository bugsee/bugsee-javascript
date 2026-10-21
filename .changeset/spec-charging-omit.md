---
'@bugsee/browser': patch
---

`charging` is no longer written when the battery level is unreadable. It used to substitute level `0` and write `{state:1|2}`, a fabricated reading; an unreadable battery now writes neither `battery` nor `charging` (spec: `bundle/traces.md#charging`).
