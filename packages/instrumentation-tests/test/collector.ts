// The mock collector now lives in @bugsee/e2e-kit so every harness shares ONE — including its
// schema validation, which four of the five suites previously did without. Re-exported here so the many
// existing `./collector` imports in this package keep working.
export {
  type CapturedUpload,
  type ContractViolation,
  type MockCollector,
  startMockCollector,
} from '@bugsee/e2e-kit';
