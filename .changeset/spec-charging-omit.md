---
'@bugsee/browser': patch
---

`charging` is no longer written when the battery level is unreadable. It used to be derived from a substituted level `0`, so the `full` state (3) could never be reached and the entry claimed a battery we could not read; an unreadable battery now writes neither `battery` nor `charging` (spec: `bundle/traces.md#charging`). `battery_charging_time_s` / `battery_discharging_time_s` are unaffected and are still written when the level is unreadable. Edge: `charging` is held, so if the level went from readable to unreadable mid-session the last charging state would keep being re-recorded, exactly like `battery` (not reachable in practice).
