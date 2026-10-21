---
'@bugsee/browser': patch
---

Removed the dead angle-only branch of `orientationToWire` (nothing fed it). The `orientation` trace is written only when the engine supplies both Screen Orientation `type` and `angle`, otherwise nothing; no behaviour change for any real input.
