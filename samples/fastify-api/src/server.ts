import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { setupFastify } from '@bugsee/fastify';
import { launchPrimary } from './bugsee';
import { buildMetricsPlugin } from './plugins/metrics';
import { buildScenariosPlugin } from './routes/scenarios';
import { MetricsStore } from './store';
import { startThirdPartyService } from './third-party';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5404);
const THIRD_PARTY_PORT = Number(process.env.THIRD_PARTY_PORT ?? 5405);

// 1. Bugsee — launch BEFORE building the app so every capture source (console, network, ...) is live
//    for the very first request.
const client = launchPrimary();

// 2. The "third-party" alerting service the Metrics API calls when an ingested value crosses a
//    threshold.
startThirdPartyService(THIRD_PARTY_PORT);

// 3. The Metrics Ingest API itself.
const store = new MetricsStore(join(__dirname, '..', 'data', 'db.json'));
const app = Fastify({ logger: false });

// setupFastify: installs onRequest/onError/onResponse/onRequestAbort hooks on the ROOT instance —
// Fastify hooks cascade to every registered child plugin (metrics, scenarios), so this one call covers
// the whole real app plus the diagnostic /scenarios/* surface.
setupFastify(app, {
  user: (req) => {
    const header = req.headers['x-scenario-user'];
    if (typeof header === 'string') return header;
    const auth = req.headers.authorization;
    const authHeader = Array.isArray(auth) ? auth[0] : auth;
    return authHeader?.startsWith('Bearer ') === true ? 'metrics-api-client' : undefined;
  },
  onError: (error) => {
    // eslint-disable-next-line no-console
    console.error('[bugsee fastify onError]', error);
  },
});

app.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
  await reply.send({ ok: true, isLaunched: client.isLaunched() });
});

// The app's own final error responder. Fastify's default error handler already replies with the
// error's statusCode (or 500) as JSON; this override just normalizes the response shape.
//
// MUST be installed BEFORE `app.register(...)` below. Fastify's encapsulation model snapshots the
// parent instance's error handler at the moment a child plugin is registered — a `setErrorHandler`
// call made on the root AFTER registration is invisible to routes already registered inside that
// plugin (verified: with this call after the `register()`s, `/scenarios/s5/route-throw` returned
// Fastify's own default envelope, not this shape). Fastify snapshots the parent's error handler at
// registration time — the same encapsulation rule that makes a plugin-scoped `setErrorHandler` win
// over this one, which is what FINDINGS.md's F-3 is about.
app.setErrorHandler(async (err: Error & { statusCode?: number }, _req: FastifyRequest, reply: FastifyReply) => {
  const status = err.statusCode ?? 500;
  await reply.status(status).send({ error: err.message });
});

await app.register(buildMetricsPlugin(store), { prefix: '/api/v1/metrics' });
await app.register(buildScenariosPlugin(), { prefix: '/scenarios' });

await app.listen({ port: PORT, host: '127.0.0.1' });
// eslint-disable-next-line no-console
console.log(`Metrics Ingest API listening on http://127.0.0.1:${PORT}`);
// eslint-disable-next-line no-console
console.log(`Third-party alert webhook mock on http://127.0.0.1:${THIRD_PARTY_PORT}`);
