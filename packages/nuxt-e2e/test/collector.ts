// The mock collector now lives in @bugsee/e2e-kit (Wave V0). This package used to carry its own diverged
// copy, which — critically — did NO schema validation, so the entry-payload contract added in Wave 3b.2
// covered instrumentation-tests alone. Re-exported here so existing `./collector` imports keep working.
export { type CapturedUpload, type MockCollector, startMockCollector } from '@bugsee/e2e-kit';
