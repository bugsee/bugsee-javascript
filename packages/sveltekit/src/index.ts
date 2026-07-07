// @bugsee/sveltekit — the portable `.` entry (node + edge safe; imports only @bugsee/adapter-kit + type-only).
//
// The SvelteKit meta-adapter: server error hook (`handleError`), the request `handle` hook (per-request
// context + trace-meta injection), and server/client/edge init entries (added behind their subpaths). This
// `.` entry holds the runtime-portable pieces so `hooks.server.ts` can import them on any deploy target.
export {
  type CreateHandleServerErrorOptions,
  createHandleServerError,
  handleError,
  handleErrorWithBugsee,
  type SvelteKitHandleServerError,
  type SvelteKitServerErrorInput,
} from './handle-error';
