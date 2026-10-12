// The bundle-assertion library now lives in @bugsee/e2e-kit. Re-exported here so this package's
// existing `./bundle` imports keep working.
export {
  assertBundleIntegrity,
  assertNoContractViolations,
  assertNoSecrets,
  type ParsedBundle,
  parseBundles,
  readJson,
  type UploadsSource,
  type ViolationSource,
} from '@bugsee/e2e-kit';
