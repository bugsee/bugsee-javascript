// Fixture Nuxt app for the real-boot e2e. Registers @bugsee/nuxt and points the server SDK at a mock
// collector (via the NUXT_BUGSEE_ENDPOINT env override at boot — the port is only known at test time).
export default defineNuxtConfig({
  modules: ['@bugsee/nuxt'],
  bugsee: {
    appToken: 'e2e-token',
    // `endpoint` must exist in runtimeConfig so `NUXT_BUGSEE_ENDPOINT` can override it at boot. Lean +
    // deterministic capture: memory store, no background detectors/traces.
    server: {
      endpoint: '',
      capturedDataStore: 'memory',
      detectHangs: false,
      captureSystemTraces: false,
      captureSystemEvents: false,
    },
    client: { endpoint: '' },
  },
  // The @bugsee/* + bugsee packages are consumed as TS SOURCE in the workspace — Nuxt/Vite must transpile
  // them (they are not pre-built to JS in dev).
  build: { transpile: [/bugsee/] },
  ssr: true,
  telemetry: false,
  devtools: { enabled: false },
  compatibilityDate: '2025-01-01',
});
