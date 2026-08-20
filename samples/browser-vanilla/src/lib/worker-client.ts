// Main-thread bridge to the price-computation Web Worker (src/worker/price-worker.ts). A real
// postMessage round trip: the worker does the discount math and replies; also used to trigger the
// worker's deliberate uncaught throw from the Scenario panel.

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, (result: { discounted: number[]; total: number }) => void>();

function getWorker(): Worker {
  if (worker === undefined) {
    worker = new Worker(new URL('../worker/price-worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type: string; id?: number; discounted?: number[]; total?: number };
      if (data.type === 'result' && data.id !== undefined) {
        const resolve = pending.get(data.id);
        if (resolve !== undefined) {
          pending.delete(data.id);
          resolve({ discounted: data.discounted ?? [], total: data.total ?? 0 });
        }
      }
    });
  }
  return worker;
}

export function computeDiscount(prices: number[], discountPct: number): Promise<{ discounted: number[]; total: number }> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ type: 'compute', id, prices, discountPct });
  });
}

export function workerLog(message: string): void {
  getWorker().postMessage({ type: 'log', message });
}

export function triggerWorkerThrow(): void {
  getWorker().postMessage({ type: 'throw' });
}
