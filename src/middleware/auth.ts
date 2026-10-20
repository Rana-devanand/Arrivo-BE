import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Db } from '../db/types.js';
import { unauthorized } from '../lib/errors.js';
import type { AuthUser } from '../types.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

/** Verifies the Bearer token and makes sure the user has a profile row. */
export function requireAuth(db: Db): RequestHandler {
  const known = new Set<string>();
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw unauthorized();
    const token = header.slice(7).trim();
    if (!token) throw unauthorized();

    const user = await db.authenticate(token);
    if (!user) throw unauthorized(db.rejectHint?.(token) ?? 'Invalid or expired token');

    if (!known.has(user.id)) {
      await db.upsertProfile(user);
      known.add(user.id);
      if (known.size > 5000) known.clear();
    }
    req.user = user;
    next();
  };
}

export function userOf(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
