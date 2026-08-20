import { Router, type Request, type Response } from 'express';
import type { JsonFileStore } from '../store';
import { paginate, parsePagination, requireString, ValidationError } from '../validation';

const THIRD_PARTY_PORT = process.env.THIRD_PARTY_PORT ?? '5305';

/** Outbound call to the "priority scoring" third-party service — real network capture + trace
 *  propagation material (S7/S10). Never blocks task creation: a failure just skips the score. */
async function scoreTask(title: string): Promise<number | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${THIRD_PARTY_PORT}/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { score?: number };
    return body.score;
  } catch {
    return undefined;
  }
}

// mergeParams: true so :id (the project id) from the parent router is visible here — needed for the
// route-naming scenario (http.route must resolve to the full pattern, not the concrete id).
export function buildTasksRouter(db: JsonFileStore): Router {
  const router = Router({ mergeParams: true });

  const requireProject = (req: Request, res: Response): boolean => {
    if (db.getProject(req.params.id as string) === undefined) {
      res.status(404).json({ error: 'project not found' });
      return false;
    }
    return true;
  };

  router.get('/', (req: Request, res: Response) => {
    if (!requireProject(req, res)) return;
    const { page, pageSize } = parsePagination(req.query as Record<string, unknown>);
    res.json(paginate(db.listTasks(req.params.id as string), page, pageSize));
  });

  router.post('/', async (req: Request, res: Response) => {
    if (!requireProject(req, res)) return;
    try {
      const title = requireString((req.body as { title?: unknown } | undefined)?.title, 'title');
      const task = db.createTask(req.params.id as string, title);
      const score = await scoreTask(title);
      res.status(201).json({ ...task, score: score ?? null });
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.get('/:taskId', (req: Request, res: Response) => {
    if (!requireProject(req, res)) return;
    const task = db.getTask(req.params.id as string, req.params.taskId as string);
    if (task === undefined) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    res.json(task);
  });

  router.patch('/:taskId', (req: Request, res: Response) => {
    if (!requireProject(req, res)) return;
    try {
      const body = req.body as { title?: unknown; done?: unknown } | undefined;
      const patch: { title?: string; done?: boolean } = {};
      if (body?.title !== undefined) patch.title = requireString(body.title, 'title');
      if (body?.done !== undefined) {
        if (typeof body.done !== 'boolean') throw new ValidationError('"done" must be a boolean');
        patch.done = body.done;
      }
      const task = db.updateTask(req.params.id as string, req.params.taskId as string, patch);
      if (task === undefined) {
        res.status(404).json({ error: 'task not found' });
        return;
      }
      res.json(task);
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.delete('/:taskId', (req: Request, res: Response) => {
    if (!requireProject(req, res)) return;
    const deleted = db.deleteTask(req.params.id as string, req.params.taskId as string);
    if (!deleted) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
