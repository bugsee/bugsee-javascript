// The real Metrics Ingest API: schema-validated event ingestion, listing, per-metric aggregation and
// an admin sub-plugin — nested TWO levels deep (`/api/v1/metrics` -> `/admin`), which is what proves
// `http.route`/the `http.server` transaction name reflects the FULL merged Fastify pattern rather than
// just the innermost route's own local string (docs/samples/PLAN.md §5.14-20's route-naming contract).
//
// Ingesting a metric whose value crosses ALERT_THRESHOLD makes a REAL outbound call to the third-party
// alert webhook (src/third-party.ts) — this is what exercises S7 (network capture) and S10
// (distributed tracing) as a side effect of genuine application behaviour, not a synthetic scenario
// route.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireBearerAuth } from '../auth';
import type { MetricsStore } from '../store';

const ALERT_THRESHOLD = 90;
const THIRD_PARTY_PORT = process.env.THIRD_PARTY_PORT ?? '5405';
const alertUrl = `http://127.0.0.1:${THIRD_PARTY_PORT}/alert`;

const ingestSchema = {
  body: {
    type: 'object',
    required: ['name', 'value'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1 },
      value: { type: 'number' },
      tags: { type: 'object', additionalProperties: { type: 'string' } },
    },
  },
} as const;

interface IngestBody {
  name: string;
  value: number;
  tags?: Record<string, string>;
}

function parsePagination(query: Record<string, unknown>): { page: number; pageSize: number } {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(query.pageSize ?? '20'), 10) || 20));
  return { page, pageSize };
}

export function buildMetricsPlugin(store: MetricsStore) {
  return async function metricsPlugin(fastify: FastifyInstance): Promise<void> {
    // Scoped to THIS plugin (and its children) only — Fastify hooks are encapsulated, so
    // /scenarios/* and /health never see this auth check.
    fastify.addHook('preHandler', requireBearerAuth);

    fastify.post(
      '/',
      { schema: ingestSchema },
      async (req: FastifyRequest<{ Body: IngestBody }>, reply: FastifyReply) => {
        const { name, value, tags } = req.body;
        const event = store.ingest(name, value, tags ?? {});
        let alerted = false;
        let traceparentSeen: string | null = null;
        if (value > ALERT_THRESHOLD) {
          try {
            const r = await fetch(alertUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name, value }),
            });
            const body = (await r.json()) as { traceparentSeen?: string | null };
            alerted = r.ok;
            traceparentSeen = body.traceparentSeen ?? null;
          } catch {
            alerted = false; // the alert webhook being down must not fail ingestion
          }
        }
        await reply.status(201).send({ event, alerted, traceparentSeen });
      },
    );

    fastify.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as Record<string, unknown>;
      const { page, pageSize } = parsePagination(query);
      const name = typeof query.name === 'string' ? query.name : undefined;
      await reply.send(store.list(name, page, pageSize));
    });

    fastify.get(
      '/:name/stats',
      async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
        const stats = store.stats(req.params.name);
        if (stats === undefined) {
          await reply.status(404).send({ error: `no events for metric "${req.params.name}"` });
          return;
        }
        await reply.send(stats);
      },
    );

    fastify.delete(
      '/:name',
      async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
        const deleted = store.deleteSeries(req.params.name);
        await reply.status(deleted ? 200 : 404).send({ deleted });
      },
    );

    // Nested TWO levels deep: full pattern is /api/v1/metrics/admin/*.
    await fastify.register(buildAdminPlugin(store), { prefix: '/admin' });
  };
}

function buildAdminPlugin(store: MetricsStore) {
  return async function adminPlugin(fastify: FastifyInstance): Promise<void> {
    // A SEPARATE, stricter hook — proves plugin-scoped hook encapsulation: this one applies only to
    // /api/v1/metrics/admin/*, layered ON TOP of the parent's bearer-auth hook (both run).
    fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.headers['x-admin-key'] !== 'admin-dev-key') {
        await reply.status(403).send({ error: 'missing/invalid x-admin-key' });
      }
    });

    fastify.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
      await reply.send({ ok: true, names: store.names().length });
    });

    fastify.post('/purge', async (_req: FastifyRequest, reply: FastifyReply) => {
      const purged = store.purgeAll();
      await reply.send({ purged });
    });

    // PARAMETERIZED ON PURPOSE — this is the route the two-level route-naming wire check asserts on.
    // GENERAL RULE: a route-naming check on a STATIC route CANNOT discriminate. When `routeOf` returns
    // undefined the SDK falls back to `urlPath(info.url)`
    // (packages/node/src/server-instrument.ts:148-154), which strips only the query — so for a static
    // route such as `/admin/health` the fallback string (`GET /api/v1/metrics/admin/health`) is
    // BYTE-IDENTICAL to the pattern form, and a check asserting the pattern reads green even if route
    // naming is completely broken. Only a route carrying a path PARAMETER separates the two answers.
    // (A peer sample, angular-spa, hit exactly this with a static `/expenses` and fixed it the same
    // way, by moving the assertion to `/expenses/:id`.)
    fastify.get(
      '/series/:name/summary',
      async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
        const stats = store.stats(req.params.name);
        await reply.send({ name: req.params.name, known: stats !== undefined });
      },
    );
  };
}
