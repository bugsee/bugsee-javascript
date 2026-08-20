// Bearer-token auth middleware. Real (if simple) auth: a missing/wrong token is rejected before the
// route ever runs, which also gives us a natural "middleware BEFORE the route" position to exercise
// exceptions from (see /scenarios/s5/middleware-throw).
import type { NextFunction, Request, Response } from 'express';

export const API_TOKEN = process.env.API_TOKEN ?? 'task-api-dev-token';

export function requireBearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  if (token === undefined) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  if (token !== API_TOKEN) {
    res.status(403).json({ error: 'invalid bearer token' });
    return;
  }
  next();
}
