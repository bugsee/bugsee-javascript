// Minimal request validation — no schema library needed for two small resources. Every validation
// failure is a genuine 4xx returned directly (never thrown), so it never reaches Bugsee's errorHandler
// — see scenarios.md S-4xx.
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`"${field}" must be a non-empty string`);
  }
  return value.trim();
}

export function parsePagination(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(query.pageSize ?? '20'), 10) || 20));
  return { page, pageSize };
}

export function paginate<T>(items: T[], page: number, pageSize: number) {
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    total: items.length,
    totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
  };
}
