// An EDGE route — its presence is what makes Next run the `edge-server` compilation, which is the
// compilation `instrumentation.ts` must not drag the Node SDK into.
export const runtime = 'edge';

export function GET(): Response {
  return new Response('ok');
}
