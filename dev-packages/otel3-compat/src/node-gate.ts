// OpenTelemetry JS 3.x declares `engines.node >=22.15.0` on core / resources / sdk-trace. The repo's CI matrix
// is Node 18-24, so the OTel 3 suites must stand down below that floor instead of failing the old legs.

/** The first Node release OpenTelemetry JS 3.x supports. */
export const OTEL3_MIN_NODE = [22, 15, 0] as const;

/** Compare a dotted Node version (`process.versions.node` shape) against `min`. */
export function nodeAtLeast(
  version: string,
  min: readonly [number, number, number] = OTEL3_MIN_NODE,
): boolean {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    const need = min[i] as number;
    if (have !== need) return have > need;
  }
  return true;
}

/** True when the running Node can load OpenTelemetry JS 3.x. */
export const otel3Supported: boolean = nodeAtLeast(process.versions.node);

/** Suite title suffix that states WHY the suite is skipped, so a skip in the report is self-explanatory. */
export const OTEL3_SKIP_NOTE = 'needs Node >= 22.15 (OpenTelemetry JS 3.x engines floor)';

/**
 * Whether a skip of the OTel 3 suite must be treated as a FAILURE. A silent skip on a runner whose Node is too
 * old would let the 3.x coverage rot unnoticed, so the CI job that runs Node 22 sets `BUGSEE_REQUIRE_OTEL3=1`.
 */
export function skipIsForbidden(env: Record<string, string | undefined>): boolean {
  return env.BUGSEE_REQUIRE_OTEL3 === '1';
}

export const otel3Required: boolean = skipIsForbidden(process.env);
