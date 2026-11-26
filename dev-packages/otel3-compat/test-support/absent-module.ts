// Stands in for `@opentelemetry/sdk-trace-base` in this package: OpenTelemetry JS 3.x REMOVED it, so an app on
// 3.x does not have it. Importing it throws, exactly like a missing module, which is what makes
// `@bugsee/nextjs` fall through to `@opentelemetry/sdk-trace` (see vitest.config.ts).
throw new Error(
  'Cannot find module @opentelemetry/sdk-trace-base (removed in OpenTelemetry JS 3.x)',
);
