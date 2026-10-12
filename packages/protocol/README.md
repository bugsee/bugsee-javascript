# @bugsee/protocol

Canonical wire shapes: types + sanitizer lists + shape redaction + option-key translator + enum maps

**Status:** implemented. The single source of truth for the wire contract, byte-identical to the Bugsee
mobile SDKs where they overlap.

Implemented: wire-shape types, bundle constants, log-level/severity enum translation, option-key
translation, sanitizer denylists and shape redaction.

Deferred to `@bugsee/core` (core-coupled, not wire-shape concerns): URL path scrubbing, error-message and
stack-frame scrubbing, and ring-buffer-to-bundle serializers (`CaptureProvider`).
