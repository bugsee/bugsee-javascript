import { Router, type Request, type Response } from 'express';
import type { JsonFileStore } from '../store';
import { paginate, parsePagination, requireString, ValidationError } from '../validation';

export function buildProjectsRouter(db: JsonFileStore): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const { page, pageSize } = parsePagination(req.query as Record<string, unknown>);
    res.json(paginate(db.listProjects(), page, pageSize));
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const name = requireString((req.body as { name?: unknown } | undefined)?.name, 'name');
      res.status(201).json(db.createProject(name));
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message }); // 4xx — never reaches Bugsee (not thrown)
        return;
      }
      throw err;
    }
  });

  router.get('/:id', (req: Request, res: Response) => {
    const project = db.getProject(req.params.id as string);
    if (project === undefined) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    res.json(project);
  });

  router.patch('/:id', (req: Request, res: Response) => {
    try {
      const patch: { name?: string } = {};
      const body = req.body as { name?: unknown } | undefined;
      if (body?.name !== undefined) patch.name = requireString(body.name, 'name');
      const project = db.updateProject(req.params.id as string, patch);
      if (project === undefined) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      res.json(project);
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const deleted = db.deleteProject(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
