import { timingSafeEqual } from 'node:crypto';

import { Router, type Request } from 'express';

import type { Db } from '../db/types.js';
import { sweep } from '../jobs/sweep.js';
import { notFound, unauthorized } from '../lib/errors.js';
import type { PlacesProvider } from '../lib/places.js';

/**
 * Housekeeping for hosts that cannot run timers (Vercel). A scheduler (Supabase
 * pg_cron) calls these with `Authorization: Bearer <CRON_SECRET>`; without
 * CRON_SECRET the routes do not exist.
 */
export function internalRoutes(db: Db, cronSecret: string | undefined, places: PlacesProvider): Router {
  const r = Router();

  const authorize = (req: Request) => {
    if (!cronSecret) throw notFound();
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const want = Buffer.from(cronSecret);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw unauthorized();
  };

  r.get('/internal/overdue', async (req, res) => {
    authorize(req);
    res.json({ markedOverdue: await db.markOverdue(new Date().toISOString()) });
  });

  /** Every 5 minutes: overdue, "location stopped" alerts and due progress updates (FR-TRK-22). */
  r.all('/internal/sweep', async (req, res) => {
    authorize(req);
    res.json(await sweep(db, places));
  });

  return r;
}
