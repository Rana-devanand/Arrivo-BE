import { Router } from 'express';
import { z } from 'zod';

import { isOpen } from '../domain/journeyRules.js';
import type { Db } from '../db/types.js';
import { badRequest } from '../lib/errors.js';
import type { Cloudinary } from '../lib/cloudinary.js';
import { requireAuth, userOf } from '../middleware/auth.js';
import { parse } from '../middleware/errors.js';

const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number');

const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  phone: phone.nullable().optional(),
  /** The Cloudinary address of the profile photo, or null to remove it. */
  avatarUrl: z.string().url().max(500).nullable().optional(),
});

const deviceSchema = z.object({
  platform: z.enum(['ios', 'android', 'web']),
  pushToken: z.string().min(10).max(4096),
});

export function profileRoutes(db: Db, photos: Cloudinary): Router {
  const r = Router();
  r.use(requireAuth(db));

  r.get('/me', async (req, res) => {
    const user = userOf(req);
    res.json({ ...(await db.upsertProfile(user)), email: user.email });
  });

  r.put('/me', async (req, res) => {
    const patch = parse(updateSchema, req.body);
    const user = userOf(req);
    await db.upsertProfile(user);
    // Only this user's own Cloudinary image may be used as the photo.
    if (patch.avatarUrl && !photos.isOwnAvatar(patch.avatarUrl, user.id)) {
      throw badRequest('That photo address is not valid. Upload the photo from the app.');
    }
    res.json({ ...(await db.updateProfile(user.id, patch)), email: user.email });
  });

  /** A short-lived, signed permit to upload this user's profile photo to Cloudinary. */
  r.post('/me/avatar/ticket', (req, res) => {
    res.json(photos.ticket(userOf(req).id));
  });

  /** Account deletion request. Ends a journey in progress first (SRS FR-ACC-05). */
  r.delete('/me', async (req, res) => {
    const user = userOf(req);
    const open = await db.getOpenJourney(user.id);
    if (open && isOpen(open.status)) {
      const now = new Date().toISOString();
      await db.updateJourney(user.id, open.id, { status: 'cancelled', endedAt: now }, ['active', 'overdue']);
    }
    await db.requestAccountDeletion(user.id);
    res.status(202).json({ status: 'deletion_requested' });
  });

  r.post('/devices', async (req, res) => {
    const body = parse(deviceSchema, req.body);
    await db.upsertDevice(userOf(req).id, body.platform, body.pushToken);
    res.status(204).end();
  });

  return r;
}
