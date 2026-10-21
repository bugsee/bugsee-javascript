---
'@bugsee/browser': patch
---

`ram_js_heap_free` is clamped at 0 (`max(limit - used, 0)`) so a heap reading above the reported limit never writes a negative free (matches Node). Unusable inputs were already omitted by the process tracker.
