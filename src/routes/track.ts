import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { isOpen } from '../domain/journeyRules.js';
import type { Db } from '../db/types.js';
import { badRequest, gone, notFound } from '../lib/errors.js';
import { parse } from '../middleware/errors.js';
import { pointsSchema } from './journeys.js';

/**
 * Location upload for the background service on the phone. The service runs
 * without the app's sign-in session, so it uses the journey's private track
 * token instead. The token only lets it add location points to that one journey,
 * and stops working the moment the journey ends.
 */
export function trackRoutes(db: Db): Router {
  const r = Router();
  r.use('/track', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

  async function open(token: string) {
    if (token.length < 20 || token.length > 80) throw notFound('Unknown journey');
    const found = await db.getJourneyByTrackToken(token);
    if (!found) throw notFound('Unknown journey');
    if (!isOpen(found.journey.status)) throw gone('This journey has ended');
    return found.journey;
  }

  /** Where things stand: lets the service notice a journey ended or the arrival time moved. */
  r.get('/track/:token', async (req, res) => {
    const j = await open(String(req.params.token));
    res.json({ status: j.status, expectedArrival: j.expectedArrival });
  });

  r.post('/track/:token/location', async (req, res) => {
    const j = await open(String(req.params.token));
    const { points } = parse(pointsSchema, req.body);
    const limit = Date.now() + 5 * 60_000;
    const sane = points.filter((p) => new Date(p.recordedAt).getTime() <= limit);
    if (sane.length === 0) throw badRequest('Location timestamps are in the future');
    await db.addLocationPoints(j.id, sane);
    res.status(202).json({ accepted: sane.length, status: j.status, expectedArrival: j.expectedArrival });
  });

  return r;
}
