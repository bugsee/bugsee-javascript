// A 200 endpoint used for readiness probing — crucially an ENDPOINT (not a page), so hitting it proves the
// SDK launches from the middleware for endpoint-only traffic (Astro's page-ssr injectScript would not).
export function GET(): Response {
  return new Response('ok', { status: 200 });
}
