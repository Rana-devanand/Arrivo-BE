import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import type { Db } from '../db/types.js';
import type { RoutingProvider } from '../lib/routing.js';
import { requireAuth } from '../middleware/auth.js';
import { parse } from '../middleware/errors.js';

const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);

const firstLast = z.enum(['walk', 'bike', 'car']);

const planSchema = z.object({
  oLat: lat,
  oLng: lng,
  dLat: lat,
  dLng: lng,
  mode: z.enum(['walk', 'bike', 'car', 'train', 'metro']),
  // Train or metro: which stations, and how to get to and from them.
  boardName: z.string().trim().max(120).optional(),
  boardLat: lat.optional(),
  boardLng: lng.optional(),
  alightName: z.string().trim().max(120).optional(),
  alightLat: lat.optional(),
  alightLng: lng.optional(),
  access: firstLast.default('car'),
  egress: firstLast.default('car'),
});

const stationsSchema = z.object({ lat, lng, mode: z.enum(['train', 'metro']) });

/** Distance, time and the path on the map for a trip from A to B. */
export function planRoutes(db: Db, routing: RoutingProvider): Router {
  const r = Router();
  r.use(requireAuth(db));
  r.use('/routes', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));

  r.get('/routes/plan', async (req, res) => {
    const q = parse(planSchema, req.query);
    const hasVia =
      q.boardLat !== undefined && q.boardLng !== undefined && q.alightLat !== undefined && q.alightLng !== undefined;
    const plan = await routing.plan({
      origin: { lat: q.oLat, lng: q.oLng },
      destination: { lat: q.dLat, lng: q.dLng },
      mode: q.mode,
      via:
        hasVia && (q.mode === 'train' || q.mode === 'metro')
          ? {
              board: { name: q.boardName ?? 'Boarding station', lat: q.boardLat!, lng: q.boardLng! },
              alight: { name: q.alightName ?? 'Arrival station', lat: q.alightLat!, lng: q.alightLng! },
              access: q.access,
              egress: q.egress,
            }
          : undefined,
    });
    res.json(plan);
  });

  /** Railway or metro stations near a place, closest first. */
  r.get('/routes/stations', async (req, res) => {
    const q = parse(stationsSchema, req.query);
    res.json({ items: await routing.stations({ lat: q.lat, lng: q.lng }, q.mode) });
  });

  return r;
}
