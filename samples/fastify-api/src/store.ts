// A tiny file-backed JSON store for the Metrics Ingest API. Not a real time-series database — a real
// one would be overkill for a sample whose job is to exercise @bugsee/fastify — but the persistence is
// real: restart the server and your metrics are still there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MetricEvent {
  id: string;
  name: string;
  value: number;
  tags: Record<string, string>;
  createdAt: string;
}

export interface MetricStats {
  name: string;
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}

interface Db {
  events: MetricEvent[];
}

export class MetricsStore {
  private db: Db;

  constructor(private readonly path: string) {
    this.db = this.load();
  }

  private load(): Db {
    if (!existsSync(this.path)) return { events: [] };
    try {
      const raw = readFileSync(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Db>;
      return { events: parsed.events ?? [] };
    } catch {
      // A corrupt store file must not take the whole API down at boot.
      return { events: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.db, null, 2));
  }

  ingest(name: string, value: number, tags: Record<string, string> = {}): MetricEvent {
    const event: MetricEvent = {
      id: randomShortId(),
      name,
      value,
      tags,
      createdAt: new Date().toISOString(),
    };
    this.db.events.push(event);
    this.save();
    return event;
  }

  names(): string[] {
    return [...new Set(this.db.events.map((e) => e.name))].sort();
  }

  list(name: string | undefined, page: number, pageSize: number) {
    const filtered = name === undefined ? this.db.events : this.db.events.filter((e) => e.name === name);
    const start = (page - 1) * pageSize;
    return {
      items: filtered.slice(start, start + pageSize),
      page,
      pageSize,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    };
  }

  stats(name: string): MetricStats | undefined {
    const series = this.db.events.filter((e) => e.name === name);
    if (series.length === 0) return undefined;
    const values = series.map((e) => e.value);
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      name,
      count: series.length,
      sum,
      avg: sum / series.length,
      min: Math.min(...values),
      max: Math.max(...values),
    };
  }

  deleteSeries(name: string): boolean {
    const before = this.db.events.length;
    this.db.events = this.db.events.filter((e) => e.name !== name);
    this.save();
    return this.db.events.length < before;
  }

  purgeAll(): number {
    const count = this.db.events.length;
    this.db.events = [];
    this.save();
    return count;
  }
}

function randomShortId(): string {
  return Math.random().toString(36).slice(2, 10);
}
