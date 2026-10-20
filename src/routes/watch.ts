import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { WATCH_GRACE_MS, isOpen } from '../domain/journeyRules.js';
import type { Db } from '../db/types.js';
import { gone, notFound } from '../lib/errors.js';

/**
 * Public, read-only view for people without the app (SRS FR-CON-07).
 * No sign-in; access is the unguessable token. Strictly rate limited.
 */
export function watchRoutes(db: Db): Router {
  const r = Router();
  r.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false }));

  r.get('/watch/:token', async (req, res) => {
    const token = String(req.params.token);
    if (token.length < 16 || token.length > 64) throw notFound('Link not found');

    const link = await db.getWatchLink(token);
    if (!link) throw notFound('Link not found');
    if (link.revokedAt) throw gone('This link was turned off');
    if (new Date(link.expiresAt).getTime() < Date.now()) throw gone('This link has expired');

    const found = await db.getJourneyForWatch(link.journeyId);
    if (!found) throw notFound('Link not found');
    const { journey, ownerId } = found;

    const open = isOpen(journey.status);
    if (!open) {
      const ended = journey.endedAt ? new Date(journey.endedAt).getTime() : 0;
      if (Date.now() - ended > WATCH_GRACE_MS) throw gone('This journey has ended');
    }

    const fullName = await db.getDisplayName(ownerId);
    const last = open ? await db.getLastLocation(journey.id) : null;

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      travellerName: fullName.split(' ')[0] || 'Traveller',
      status: journey.status,
      destinationName: journey.destinationName,
      expectedArrival: journey.expectedArrival,
      arrivedAt: journey.arrivedAt,
      vehicle: journey.vehicle,
      vehicleImageUrl: journey.vehicleImageUrl,
      mode: journey.mode,
      destinationLat: journey.destinationLat,
      destinationLng: journey.destinationLng,
      routePolyline: open ? journey.routePolyline : null,
      note: journey.note,
      // Location is shown only while the journey is in progress.
      lastLocation: last ? { lat: last.lat, lng: last.lng, recordedAt: last.recordedAt } : null,
      serverTime: new Date().toISOString(),
    });
  });

  return r;
}
