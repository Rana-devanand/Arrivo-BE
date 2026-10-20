import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import type { Db } from '../db/types.js';
import { notFound, unauthorized } from '../lib/errors.js';

/**
 * Housekeeping for hosts that cannot run timers (Vercel). A scheduler calls this
 * every minute with `Authorization: Bearer <CRON_SECRET>`; without CRON_SECRET the
 * route does not exist.
 */
export function internalRoutes(db: Db, cronSecret: string | undefined): Router {
  const r = Router();

  r.get('/internal/overdue', async (req, res) => {
    if (!cronSecret) throw notFound();
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(cronSecret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw unauthorized();
    res.json({ markedOverdue: await db.markOverdue(new Date().toISOString()) });
  });

  return r;
}
