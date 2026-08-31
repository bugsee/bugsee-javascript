// Bearer-token auth. A plain `preHandler` hook registered inside the metrics plugin's encapsulation
// scope — so it protects only the ingest/query routes registered alongside it, and never the
// `/scenarios/*` diagnostic surface or `/health`. Also gives us a natural "hook BEFORE the route" spot
// to throw from (see /scenarios/s5/hook-throw).
import type { FastifyReply, FastifyRequest } from 'fastify';

export const API_TOKEN = process.env.API_TOKEN ?? 'metrics-api-dev-token';

export async function requireBearerAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (token === undefined) {
    await reply.status(401).send({ error: 'missing bearer token' });
    return;
  }
  if (token !== API_TOKEN) {
    await reply.status(403).send({ error: 'invalid bearer token' });
    return;
  }
}
