// The mock collector now lives in @bugsee/e2e-kit. This package used to carry its own diverged
// copy, which — critically — did NO schema validation, so the entry-payload contract
// was covered by instrumentation-tests alone. Re-exported here so existing `./collector` imports keep working.
export { type CapturedUpload, type MockCollector, startMockCollector } from '@bugsee/e2e-kit';
