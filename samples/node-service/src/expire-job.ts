// Background job: sweeps expired links periodically. Genuine app behaviour (not a Bugsee scenario) —
// it also produces a `bugsee.trace()` sample per sweep so client.trace() (S3) has organic call sites.
import type { Bugsee } from '@bugsee/node';
import type { LinkStore } from './store.ts';

export function startExpireJob(store: LinkStore, client: Bugsee, intervalMs = 5000): () => void {
  const timer = setInterval(() => {
    const removed = store.expireSweep();
    client.trace('links.expire_sweep', { removed, at: Date.now() });
    if (removed > 0) {
      client.addBreadcrumb({
        type: 'job',
        category: 'expire',
        message: `expired ${removed} link(s)`,
        level: 'info',
        data: { removed },
      });
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
