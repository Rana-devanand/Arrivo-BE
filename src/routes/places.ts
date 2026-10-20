import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import type { Db } from '../db/types.js';
import { conflict, notFound } from '../lib/errors.js';
import type { PlacesProvider } from '../lib/places.js';
import { requireAuth, userOf } from '../middleware/auth.js';
import { parse } from '../middleware/errors.js';

const MAX_SAVED = 30;

const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);
const language = z.enum(['en', 'hi']).default('en');
const session = z.string().trim().max(64).optional();

const searchSchema = z.object({
  q: z.string().trim().min(2).max(100),
  lat: lat.optional(),
  lng: lng.optional(),
  lang: language,
  session,
});
const detailsSchema = z.object({ placeId: z.string().trim().min(5).max(300), lang: language, session });
const reverseSchema = z.object({ lat, lng, lang: language });

const recentSchema = z.object({
  name: z.string().trim().min(1).max(160),
  address: z.string().trim().max(300).default(''),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  googlePlaceId: z.string().trim().max(300).nullable().optional(),
});

const savedSchema = z.object({
  kind: z.enum(['home', 'work', 'other']).default('other'),
  label: z.string().trim().min(1).max(60).optional(),
  name: z.string().trim().min(1).max(160),
  address: z.string().trim().max(300).default(''),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  googlePlaceId: z.string().trim().max(300).nullable().optional(),
});

/** Place search (Google, through this server), pin drop, and saved places. */
export function placeRoutes(db: Db, places: PlacesProvider): Router {
  const r = Router();
  r.use(requireAuth(db));
  // Every keystroke can become a request, so the limit is generous but not unlimited.
  r.use('/places', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

  r.get('/places/search', async (req, res) => {
    const q = parse(searchSchema, req.query);
    const near = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : undefined;
    const items = await places.search({ query: q.q, sessionToken: q.session, near, language: q.lang });
    res.json({ items });
  });

  r.get('/places/details', async (req, res) => {
    const q = parse(detailsSchema, req.query);
    res.json(await places.details(q.placeId, q.session, q.lang));
  });

  r.get('/places/reverse', async (req, res) => {
    const q = parse(reverseSchema, req.query);
    res.json(await places.reverse(q.lat, q.lng, q.lang));
  });

  // ---- Recent places: what the person picked before, so we do not search again ------

  r.get('/places/recent', async (req, res) => {
    res.json({ items: await db.listRecentPlaces(userOf(req).id, 20) });
  });

  r.post('/places/recent', async (req, res) => {
    const b = parse(recentSchema, req.body);
    const saved = await db.upsertRecentPlace(userOf(req).id, {
      name: b.name,
      address: b.address,
      lat: b.lat,
      lng: b.lng,
      googlePlaceId: b.googlePlaceId ?? null,
    });
    res.status(201).json(saved);
  });

  r.delete('/places/recent', async (req, res) => {
    await db.clearRecentPlaces(userOf(req).id);
    res.status(204).end();
  });

  // ---- Saved places -------------------------------------------------------

  r.get('/places/saved', async (req, res) => {
    res.json({ items: await db.listSavedPlaces(userOf(req).id) });
  });

  r.post('/places/saved', async (req, res) => {
    const user = userOf(req);
    const body = parse(savedSchema, req.body);
    const existing = await db.listSavedPlaces(user.id);
    if (existing.length >= MAX_SAVED) throw conflict(`You can save up to ${MAX_SAVED} places. Remove one first.`);
    const label = body.kind === 'home' ? 'Home' : body.kind === 'work' ? 'Work' : (body.label ?? body.name);
    // Setting Home or Work again replaces the old one.
    const old = existing.find((p) => body.kind !== 'other' && p.kind === body.kind);
    if (old) await db.deleteSavedPlace(user.id, old.id);
    // The same spot twice is just clutter.
    const dupe = existing.find((p) => p.kind === 'other' && body.kind === 'other' && Math.abs(p.lat - body.lat) < 1e-4 && Math.abs(p.lng - body.lng) < 1e-4);
    if (dupe) return void res.status(200).json(dupe);
    const saved = await db.createSavedPlace(user.id, {
      kind: body.kind,
      label,
      name: body.name,
      address: body.address,
      lat: body.lat,
      lng: body.lng,
      googlePlaceId: body.googlePlaceId ?? null,
    });
    res.status(201).json(saved);
  });

  r.delete('/places/saved/:id', async (req, res) => {
    const ok = await db.deleteSavedPlace(userOf(req).id, String(req.params.id));
    if (!ok) throw notFound('Saved place not found');
    res.status(204).end();
  });

  return r;
}
