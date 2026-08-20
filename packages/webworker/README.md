# @bugsee/webworker

The Bugsee SDK for **Web Workers** (dedicated / shared) — a DOM-less, browser-family build. See
`docs/design/sdk-design.md` §3.2/§3.3.

```ts
import { launch } from '@bugsee/webworker';

const bugsee = launch('<BUGSEE_APP_TOKEN>');
// captured automatically from here: console output, fetch/WebSocket, and any
// global `error` / `unhandledrejection` on the worker (reported as a crash / error).
```

**What it captures.** Console output → logs, network (`fetch` + `WebSocket`; `XMLHttpRequest` too in a
dedicated worker, where it exists), and global `error` → crash + `unhandledrejection` → error on the worker
`self`. The environment is the browser envelope minus the screen (a worker has `navigator` but no
`screen`/`window`): `platform.type` is `web-worker` (default) or `service-worker`, with the `navigator`
cpu/memory in `hardware`.

**Not captured** (DOM-less by nature): clicks/keys/navigation breadcrumbs, the DOM view hierarchy, and
`performance.memory` traces — all browser/DOM-only. There is no `AsyncLocalStorage` / per-request context in a
worker (stack-based).

## Service Workers

Pass `platformType: 'service-worker'`. A Service Worker is **terminated when idle and restarted per-event**, so
it gets two extra pieces (both unneeded for a long-lived Web Worker):

```ts
import { launch, withBugseeEvent } from '@bugsee/webworker';

const bugsee = launch('<BUGSEE_APP_TOKEN>', { platformType: 'service-worker' });

self.addEventListener('fetch', withBugseeEvent(bugsee, (event) => {
  event.respondWith(handle(event.request));
}));
```

- **`withBugseeEvent`** hands the SDK flush to `event.waitUntil`, keeping the worker alive until an incident's
  upload completes — the SW analog of the edge SDK's `ctx.waitUntil` (without it a fire-and-forget upload can be
  dropped when the worker is killed). It never alters your handler's outcome: your error is always the one
  rethrown, and an SDK-internal failure (or a failed upload) goes to the optional third argument —
  `withBugseeEvent(bugsee, handler, (error) => console.debug(error))` — instead of failing the event.
- **Persistence is ON by default** for `service-worker`: a durable **IndexedDB bundle queue** persists each
  incident bundle before upload and re-uploads any a prior activation left behind (e.g. killed mid-upload) on
  the next launch — so an assembled crash bundle is never lost to termination. (`persist: false` opts out;
  `persist: true` turns it on for a Web Worker.)

**Remaining follow-up:** persisting the *rolling* capture buffer across activations (an IndexedDB chunk capture
store + marker recovery) — only relevant for the rarer cross-activation case; an in-activation incident already
reports with that activation's capture.

A long-lived **dedicated/shared Web Worker** needs neither (it lives for the page's lifetime) and runs
memory-only by default. Tier 2.
