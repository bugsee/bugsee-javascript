# @bugsee/protocol

Canonical wire shapes: types + sanitizer lists + shape redaction + option-key translator + enum maps

**Status:** implemented. Tier 0 (design §5). The single source of truth for the wire contract
(design §8); byte-identical to the Bugsee mobile SDKs where they overlap.

Implemented: wire-shape types (§8.5–§8.7), bundle constants (§8.4), log-level/severity enum
translation (§8.9), option-key translation, sanitizer denylists + shape redaction (§8.10).

Deferred to `@bugsee/core` (core-coupled, not wire-shape concerns): URL path scrubbing (§8.10),
error-message/stack-frame scrubbing (§14.3), and ring-buffer→bundle serializers (`CaptureProvider`).

Implementation follows `docs/implementation-standards.md`.
