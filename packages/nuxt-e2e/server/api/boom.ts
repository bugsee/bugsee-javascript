// A server route that throws a real 500 — Nitro fires its `error` hook, which @bugsee/nuxt's installed
// Nitro plugin reports to the collector (the moat's server-error path).
export default defineEventHandler(() => {
  throw new Error('e2e nitro boom');
});
