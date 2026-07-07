// @bugsee/sveltekit — the `handle` hook (SvelteKit's request hook, `Handle`).
//
// SvelteKit's `handle` WRAPS `resolve(event)`, so it is the natural place to inject the trace `<meta>` into
// the SSR response (`transformPageChunk`) — the client pageload then adopts the server-request trace
// (FE↔BE join). On node the per-request context comes from `@bugsee/node`'s `node:http` emit-patch (so the
// active trace is visible here); the `@bugsee/sveltekit/edge` handle additionally OPENS the context (edge
// has no emit-patch — SvelteKit's wrapping `handle` is what makes full per-request context possible there,
// unlike Nuxt/Nitro).
//
// Compose it in `src/hooks.server.ts`: `export const handle = sequence(bugseeHandle, myHandle)` — SvelteKit's
// `sequence()` merges each handle's `transformPageChunk`. RUNTIME-PORTABLE (adapter-kit only).
import { type TraceDataOptions, traceMetaTag } from '@bugsee/adapter-kit';

/** The `resolve` options subset we set (structural; no `@sveltejs/kit` import). */
export interface SvelteKitResolveOptions {
  transformPageChunk?: (input: { html: string; done?: boolean }) => string;
}

/** The subset of SvelteKit's `Handle` input we use. */
export interface SvelteKitHandleInput {
  event: unknown;
  resolve: (event: unknown, opts?: SvelteKitResolveOptions) => unknown;
}

/** A SvelteKit `handle` hook. */
export type SvelteKitHandle = (input: SvelteKitHandleInput) => unknown;

export interface CreateHandleOptions extends TraceDataOptions {}

/** Splice a `<meta name="traceparent">` (from the active trace) in before `</head>`. A no-op when no trace is
 *  active or the chunk has no `</head>`. (`transformPageChunk` runs per chunk; `</head>` lands in one chunk.)
 *  Exported so the edge handle (`@bugsee/sveltekit/edge`) reuses the exact same injection. */
export function injectTraceMeta(html: string, options: CreateHandleOptions): string {
  if (!html.includes('</head>')) return html;
  const tag = traceMetaTag(options);
  return tag === '' ? html : html.replace('</head>', `${tag}</head>`);
}

/** Build a SvelteKit `handle` hook that injects the trace `<meta>` into the SSR `<head>`. */
export function createHandle(options: CreateHandleOptions = {}): SvelteKitHandle {
  return ({ event, resolve }) =>
    resolve(event, {
      transformPageChunk: ({ html }) => injectTraceMeta(html, options),
    });
}

/** The ready-made handle bound to the carrier client. `export const handle = bugseeHandle` in hooks.server. */
export const handle: SvelteKitHandle = createHandle();
