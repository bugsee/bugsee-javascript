# @bugsee/core

The SDK kernel (tier 1, design §5/§7/§16): the Client composition root, the single global Environment, event hubs + EventEmitter, the Interceptor/CaptureProvider/DetectionProvider contracts + provider base classes + coordinators, the extension registry, the capture aggregator over a pluggable CaptureStore (ring-buffer-backed in-memory default), the report trigger + upload pipelines, and BundleWriter. Runtime-portable: no DOM/Node/Bun globals are imported unconditionally.

**Status:** implemented (kernel). Built test-first per `docs/implementation-standards.md`. Platform-specific concerns (interceptors/providers, BugseeApi/BundleUploader transports, EnvironmentEnvelope construction) live in the platform tiers.
