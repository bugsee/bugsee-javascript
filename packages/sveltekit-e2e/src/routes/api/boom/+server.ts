// A server endpoint that throws a real 500 — SvelteKit calls `handleError`, which @bugsee/sveltekit's
// installed hook reports to the collector (the moat's server-error path).
export function GET(): Response {
  throw new Error('e2e sveltekit boom');
}
