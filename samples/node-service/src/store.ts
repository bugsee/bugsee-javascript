// A tiny JSON-file-backed link store for the "Link shortener" sample app. Deliberately simple (no
// database dependency) — the point of this sample is @bugsee/node, not the storage engine.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface LinkRecord {
  code: string;
  url: string;
  createdAt: number;
  expiresAt: number | null;
  hits: number;
  lastHitAt: number | null;
}

interface StoreShape {
  links: Record<string, LinkRecord>;
}

export class LinkStore {
  #path: string;
  #data: StoreShape;

  constructor(path: string) {
    this.#path = path;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(path)) {
      try {
        this.#data = JSON.parse(readFileSync(path, 'utf8')) as StoreShape;
      } catch {
        this.#data = { links: {} };
      }
    } else {
      this.#data = { links: {} };
    }
  }

  #persist(): void {
    writeFileSync(this.#path, JSON.stringify(this.#data, null, 2));
  }

  create(url: string, ttlMs: number | null): LinkRecord {
    let code: string;
    do {
      code = randomBytes(4).toString('hex');
    } while (this.#data.links[code] !== undefined);
    const record: LinkRecord = {
      code,
      url,
      createdAt: Date.now(),
      expiresAt: ttlMs === null ? null : Date.now() + ttlMs,
      hits: 0,
      lastHitAt: null,
    };
    this.#data.links[code] = record;
    this.#persist();
    return record;
  }

  resolve(code: string): LinkRecord | undefined {
    const record = this.#data.links[code];
    if (record === undefined) return undefined;
    if (record.expiresAt !== null && record.expiresAt <= Date.now()) return undefined;
    record.hits += 1;
    record.lastHitAt = Date.now();
    this.#persist();
    return record;
  }

  list(): LinkRecord[] {
    return Object.values(this.#data.links).sort((a, b) => b.createdAt - a.createdAt);
  }

  stats(): { total: number; active: number; expired: number; totalHits: number } {
    const all = Object.values(this.#data.links);
    const now = Date.now();
    const expired = all.filter((l) => l.expiresAt !== null && l.expiresAt <= now).length;
    return {
      total: all.length,
      active: all.length - expired,
      expired,
      totalHits: all.reduce((sum, l) => sum + l.hits, 0),
    };
  }

  /** Sweep expired links; returns how many were removed. Used by the background expiry job. */
  expireSweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [code, record] of Object.entries(this.#data.links)) {
      if (record.expiresAt !== null && record.expiresAt <= now) {
        delete this.#data.links[code];
        removed += 1;
      }
    }
    if (removed > 0) this.#persist();
    return removed;
  }
}
