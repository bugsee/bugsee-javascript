// @bugsee/fastify — Fastify adapter (tier 4, design: docs/design/framework-adapters.md).
// One-call hook-based setup over the per-request context foundation. fastify is a PEER dependency.
export {
  type FastifyAdapterOptions,
  type FastifyHookDone,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  setupFastify,
} from './hooks';
