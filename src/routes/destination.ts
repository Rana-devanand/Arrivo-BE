import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import type { Db } from '../db/types.js';
import { cached } from '../lib/cache.js';
import { AppError, notFound } from '../lib/errors.js';
import { cellOf, type NearbyServicesProvider } from '../lib/nearbyServices.js';
import type { WikiProvider } from '../lib/wiki.js';
import { requireAuth } from '../middleware/auth.js';
import { parse } from '../middleware/errors.js';

const DAY = 24 * 60 * 60_000;
/** Places do not change often; a month keeps a slow lookup to once per place. */
const INFO_TTL = 30 * DAY;
/** Google's terms limit how long place data may be kept: never longer than 30 days. */
const SERVICES_TTL = 30 * DAY;

const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);

const infoSchema = z.object({
  lat,
  lng,
  name: z.string().trim().min(1).max(120),
  city: z.string().trim().max(80).optional(),
  region: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).optional(),
});
const placeSchema = z.object({ title: z.string().trim().min(1).max(200) });
const photosSchema = z.object({ lat, lng, radius: z.coerce.number().int().min(100).max(5000).default(3000) });
const servicesSchema = z.object({ lat, lng });

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

/**
 * What to read and know about a destination, and the police stations and
 * hospitals around you. Both are slow or paid lookups, so each runs once per
 * place and is then served from the shared cache.
 */
export function destinationRoutes(db: Db, wiki: WikiProvider, services: NearbyServicesProvider): Router {
  const r = Router();
  r.use(requireAuth(db));
  r.use(['/destination', '/emergency'], rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false }));

  r.get('/destination/info', async (req, res) => {
    const q = parse(infoSchema, req.query);
    if (!wiki.enabled) await wiki.destination(q); // throws "not available"
    // About 1 km cells plus the name: the same pin and name always share one answer.
    const key = `dest:v2:${q.lat.toFixed(2)},${q.lng.toFixed(2)}:${slug(q.name)}:${slug(q.city ?? '')}:${slug(q.region ?? '')}:${slug(q.country ?? '')}`;
    const info = await cached(db, key, INFO_TTL, () => wiki.destination(q));
    if (!info) throw notFound('There is no information about this place yet.');
    res.json(info);
  });

  r.get('/destination/place', async (req, res) => {
    const q = parse(placeSchema, req.query);
    if (!wiki.enabled) await wiki.place(q.title); // throws "not available"
    const detail = await cached(db, `place:v1:${slug(q.title)}`, INFO_TTL, async () => {
      try {
        return await wiki.place(q.title);
      } catch {
        throw new AppError(502, 'info_error', 'Could not load this place. Try again in a moment.');
      }
    });
    if (!detail) throw notFound('There is no information about this place yet.');
    res.json(detail);
  });

  /** Photos taken near a point. Its own call: Commons is the slowest part, so the text never waits for it. */
  r.get('/destination/photos', async (req, res) => {
    const q = parse(photosSchema, req.query);
    if (!wiki.enabled) await wiki.photos(q, q.radius); // throws "not available"
    const radius = Math.round(q.radius / 100) * 100;
    const items = await cached(db, `photos:v1:${q.lat.toFixed(3)},${q.lng.toFixed(3)}:${radius}`, INFO_TTL, () => wiki.photos(q, radius));
    res.json({ items: items ?? [] });
  });

  /** Police stations and hospitals within 40 km. The app keeps the answer until the person has moved about that far. */
  r.get('/emergency/nearby', async (req, res) => {
    const q = parse(servicesSchema, req.query);
    if (!services.enabled) await services.find(q); // throws "not set up"
    const c = cellOf(q);
    const found = await cached(db, `svc:v1:${c.lat.toFixed(2)},${c.lng.toFixed(2)}`, SERVICES_TTL, () => services.find(q));
    res.json(found);
  });

  return r;
}
