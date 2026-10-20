import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db/types.js';
import { notFound } from '../lib/errors.js';
import { notifyFollowers } from '../lib/notify.js';
import { requireAuth, userOf } from '../middleware/auth.js';
import { parse } from '../middleware/errors.js';

const timerSchema = z.object({ minutes: z.number().int().min(5).max(240) });

const sosSchema = z.object({
  journeyId: z.string().min(1).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export function safetyRoutes(db: Db): Router {
  const r = Router();
  r.use(requireAuth(db));

  r.get('/safety/timer', async (req, res) => {
    const endsAt = await db.getSafetyTimer(userOf(req).id);
    res.json({ endsAt });
  });

  r.post('/safety/timer', async (req, res) => {
    const { minutes } = parse(timerSchema, req.body);
    const endsAt = new Date(Date.now() + minutes * 60_000).toISOString();
    await db.setSafetyTimer(userOf(req).id, endsAt);
    res.status(201).json({ endsAt });
  });

  /** "I am safe": cancels the timer. */
  r.delete('/safety/timer', async (req, res) => {
    await db.clearSafetyTimer(userOf(req).id);
    res.status(204).end();
  });

  /**
   * Records an SOS. Delivery to contacts is handled by the notification
   * service (not built yet), so the response says so honestly.
   */
  r.post('/safety/sos', async (req, res) => {
    const user = userOf(req);
    const body = parse(sosSchema, req.body);
    if (body.journeyId && !(await db.getJourney(user.id, body.journeyId))) throw notFound('Journey not found');

    const event = await db.createSos(user.id, {
      journeyId: body.journeyId ?? null,
      lat: body.lat ?? null,
      lng: body.lng ?? null,
    });
    const contacts = (await db.listContacts(user.id)).filter((c) => c.status === 'accepted');
    const who = (await db.getDisplayName(user.id)) || user.displayName || 'Someone';
    await notifyFollowers(db, user.id, undefined, {
      type: 'sos',
      title: `SOS from ${who}`,
      body: `${who} pressed the SOS button and may need help. Try calling now.`,
      data: { journeyId: body.journeyId ?? null, lat: body.lat ?? null, lng: body.lng ?? null },
    });
    res.status(201).json({ ...event, contactsToAlert: contacts.length, delivery: 'pending' });
  });

  return r;
}
