// Cyclic ring buffer (design §7.7): one per wire file-type, bounded by a fixed capacity. New items
// evict the oldest (FIFO) once full. The trigger path snapshot-copies a buffer and clears it for the
// next bundle (§7.7 atomicity), so `drain` copies-then-empties atomically.
//
// Retention note: slots are bounded by `capacity` and reused on the next push after clear/drain, so
// drained references are reclaimed on reuse — no unbounded growth, hence no explicit slot-nulling.

export interface RingBuffer<T> {
  /** Maximum number of retained items. */
  readonly capacity: number;
  /** Current number of buffered items. */
  readonly size: number;
  /** Append an item; once full, the oldest item is evicted. */
  push(item: T): void;
  /** A fresh oldest-to-newest copy of the buffered items; non-destructive. */
  toArray(): T[];
  /** Remove all items. */
  clear(): void;
  /** Atomically return the buffered items (oldest-to-newest) and empty the buffer. */
  drain(): T[];
}

export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
  }

  const data = new Array<T | undefined>(capacity);
  let head = 0; // index of the oldest item
  let count = 0; // number of buffered items

  // Local (not `this`-bound) so the methods are safe to destructure.
  const toArray = (): T[] => {
    const out: T[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(data[(head + i) % capacity] as T);
    }
    return out;
  };

  const clear = (): void => {
    // `head` need not reset: it stays a valid offset in [0, capacity), and with count 0 the buffer
    // is empty regardless of head, so subsequent push/read arithmetic stays consistent.
    count = 0;
  };

  return {
    capacity,
    get size() {
      return count;
    },
    push(item: T): void {
      data[(head + count) % capacity] = item;
      if (count < capacity) {
        count += 1;
      } else {
        // Buffer was full: we overwrote the oldest slot, so advance head to the new oldest.
        head = (head + 1) % capacity;
      }
    },
    toArray,
    clear,
    drain(): T[] {
      const out = toArray();
      clear();
      return out;
    },
  };
}
