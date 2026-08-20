// A SECOND, independent Bugsee client + a small mounted sub-app at /alt/*, dedicated to two things
// the primary app's config can't demonstrate at the same time:
//
//   1. `instrumentIncomingRequests: false` — the express adapter must still work completely on its
//      own (exactly one context + one http.server transaction), with node:http's own auto-instrument
//      OFF (docs/samples/PLAN.md §5.14-5.20).
//   2. The `requestHandler`/`errorHandler` middleware halves used BY HAND, as an alternative to
//      `setupExpress` (which the primary app uses) — both surfaces the plan asks every backend sample
//      to cover.
//
// A distinct `carrier` object gives this its own process-singleton-shaped client (the SDK's carrier
// pattern is injectable precisely for cases like this — see BugseeLaunchOptions.carrier).
import { errorHandler, type Bugsee, launch, requestHandler } from '@bugsee/express';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { createTeeTransport } from './bugsee-transport';

const SECONDARY_CARRIER = {};

let secondaryClient: Bugsee | undefined;

export function launchSecondary(): Bugsee {
  if (secondaryClient !== undefined) return secondaryClient;
  const appToken = process.env.BUGSEE_APP_TOKEN;
  if (appToken === undefined || appToken.length === 0) {
    throw new Error('BUGSEE_APP_TOKEN is not set');
  }
  secondaryClient = launch(appToken, {
    endpoint: process.env.BUGSEE_ENDPOINT ?? 'https://apidev.bugsee.com',
    sdkVersion: '1.0.0', // F-1 workaround — see src/bugsee.ts + FINDINGS.md
    appVersion: '1.0.0',
    appBuild: process.env.APP_BUILD ?? '1',
    carrier: SECONDARY_CARRIER,
    capturedDataStore: 'memory',
    detectHangs: false,
    exitOnUncaught: false,
    unhandledRejections: 'warn',
    // The whole point of this client: prove the express adapter works with the node:http
    // auto-instrument OFF.
    instrumentIncomingRequests: false,
    transport: createTeeTransport() as never,
    onError: (error) => {
      // eslint-disable-next-line no-console
      console.error('[bugsee secondary onError]', error);
    },
  });
  secondaryClient.setUserIdentifier('sample-user-alt@bugsee.dev');
  return secondaryClient;
}

export function buildAltRouter(): Router {
  const client = launchSecondary();
  const router = express.Router();

  // Used BY HAND (not setupExpress) — this is the "middleware half" of the adapter.
  router.use(requestHandler({ getClient: () => client }));

  router.get('/status', (_req: Request, res: Response) => {
    const perf = client.ext('performance');
    const active = perf.getActiveSpan();
    res.json({
      instrumentIncomingRequests: false,
      activeTransaction:
        active === undefined ? null : { op: active.getOperation(), status: active.getStatus() },
    });
  });

  router.get('/projects/:id/tasks/:taskId', (req: Request, res: Response) => {
    // Route-naming proof on the standalone adapter: http.route must be the PATTERN, not the concrete
    // path — read back off the active transaction name (default naming source is 'route' once
    // requestHandler's finalize() runs, but we can also read the matched req.route.path directly here).
    res.json({ pattern: req.route?.path, concrete: req.originalUrl });
  });

  router.get('/throw', (_req: Request, _res: Response) => {
    throw new Error('alt-app synchronous throw (adapter-alone, instrumentIncomingRequests:false)');
  });

  router.get('/throw-async', async (_req: Request, _res: Response, next: NextFunction) => {
    try {
      await Promise.resolve();
      throw new Error('alt-app async throw (adapter-alone)');
    } catch (err) {
      next(err);
    }
  });

  // Used BY HAND — the "error-handler half" of the adapter.
  router.use(errorHandler({ getClient: () => client }));
  // The app's own final error responder (Bugsee's errorHandler always forwards via next(err)).
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  });

  return router;
}
