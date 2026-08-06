// WAVE V0 — the shared verification substrate.
//
// Every e2e harness needs the same two things: a mock collector that behaves like the real control plane,
// and a way to assert on what actually arrived. They existed — in ONE harness. The other four carried
// diverged copies of the collector with no schema validation and no bundle assertions at all, so the
// entry-payload contract added in Wave 3b.2 covered exactly one suite out of five, and the meta-framework
// harnesses asserted only that a bundle ARRIVED — the very failure 3b.2 exists to prevent.
//
// Sharing them is the point: a contract check added here applies to every harness at once.

export {
  assertBundleIntegrity,
  assertNoContractViolations,
  assertNoSecrets,
  type ParsedBundle,
  parseBundles,
  readJson,
  type UploadsSource,
  type ViolationSource,
} from './bundle';
export {
  type CapturedUpload,
  type ContractViolation,
  type MockCollector,
  startMockCollector,
} from './collector';
