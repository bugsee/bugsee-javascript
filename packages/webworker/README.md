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

## Service Workers — partial (v1)

`platformType: 'service-worker'` reports the right identity and **in-event capture works** (an error thrown
while handling a `fetch`/`push`/etc. event is captured and reported within that activation). But a Service
Worker is **terminated when idle and restarted per-event with no persisted state**, so v1 has two known gaps,
tracked as follow-ups:

- **No cross-termination persistence** — the in-memory rolling buffer is empty after a restart (the design
  prescribes IndexedDB for Service Workers). Inject a persistent `captureStore` if you need this today.
- **No `event.waitUntil`-bound flush** — an incident's upload is fire-and-forget; if the worker is killed
  before it completes, it can be dropped (the same isolate-freeze hazard the edge SDK solves with
  `ctx.waitUntil`). A Service-Worker event wrapper is a follow-up.

A long-lived **dedicated/shared Web Worker** has neither limitation (it lives for the page's lifetime), so it is
fully supported memory-only. Tier 2.
