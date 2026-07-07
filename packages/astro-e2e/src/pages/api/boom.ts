// An Astro API route that throws — the middleware's next() try/catch reports it (Astro has no
// onRequestError), then rethrows so Astro renders its 500.
export function GET(): Response {
  throw new Error('e2e astro boom');
}
