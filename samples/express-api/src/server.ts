import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { setupExpress } from '@bugsee/express';
import { requireBearerAuth } from './auth';
import { launchPrimary } from './bugsee';
import { buildProjectsRouter } from './routes/projects';
import { buildScenariosRouter } from './routes/scenarios';
import { buildTasksRouter } from './routes/tasks';
import { launchSecondary } from './secondary';
import { JsonFileStore } from './store';
import { startThirdPartyService } from './third-party';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5304);
const THIRD_PARTY_PORT = Number(process.env.THIRD_PARTY_PORT ?? 5305);

// 1. Bugsee — launch BEFORE building the app so every capture source (console, network, ...) is live
//    for the very first request.
const client = launchPrimary();
launchSecondary(); // powers the /scenarios/alt/* sub-app (instrumentIncomingRequests: false)

// 2. The "third-party" service the Task API calls when scoring a new task's priority.
startThirdPartyService(THIRD_PARTY_PORT);

// 3. The Task API itself.
const db = new JsonFileStore(join(__dirname, '..', 'data', 'db.json'));
const app = express();
app.use(express.json());

// setupExpress: the one-call form. Installs the request-context middleware now and the error handler
// after the routes (deterministically, at listen()) — see packages/express/src/setup.ts.
setupExpress(app, {
  user: (req) => {
    const header = req.headers['x-scenario-user'];
    if (typeof header === 'string') return header;
    const auth = req.headers.authorization;
    const authHeader = Array.isArray(auth) ? auth[0] : auth;
    return authHeader?.startsWith('Bearer ') === true ? 'task-api-client' : undefined;
  },
  onError: (error) => {
    // eslint-disable-next-line no-console
    console.error('[bugsee express onError]', error);
  },
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, isLaunched: client.isLaunched() });
});

app.use('/projects/:id/tasks', requireBearerAuth, buildTasksRouter(db));
app.use('/projects', requireBearerAuth, buildProjectsRouter(db));
app.use('/scenarios', buildScenariosRouter());

app.use(express.static(join(__dirname, '..', 'public')));

// The app's own final error responder — Bugsee's errorHandler always forwards via next(err).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number } | undefined)?.status ?? 500;
  res.status(status).json({ error: err instanceof Error ? err.message : 'internal error' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Task API listening on http://127.0.0.1:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Third-party mock service on http://127.0.0.1:${THIRD_PARTY_PORT}`);
});
