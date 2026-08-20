// A duplicate of vite-env.d.ts's ImportMetaEnv augmentation, scoped for the worker/sw tsconfig (which
// cannot include vite/client.d.ts alongside the "WebWorker" lib without pulling in DOM types that
// conflict with it — see tsconfig.worker.json).
interface ImportMetaEnv {
  readonly BUGSEE_APP_TOKEN: string;
  readonly BUGSEE_ENDPOINT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// The Background Sync API isn't part of TS's standard "webworker" lib (still experimental / behind a
// flag in most browsers), so SyncEvent has no ambient type — declare the minimal shape this sample uses.
interface SyncEvent extends ExtendableEvent {
  readonly tag: string;
  readonly lastChance: boolean;
}
