import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { Db } from '../db/types.js';
import { forbidden, notFound } from '../lib/errors.js';
import { requireAuth, userOf } from '../middleware/auth.js';
import { parse } from '../middleware/errors.js';
import type { AdminNotificationRow, Journey } from '../types.js';

/**
 * Only profiles with user_role = ADMIN. The role is read from the database on every
 * request, so taking it away in the SQL editor works at once.
 */
function requireAdmin(db: Db): RequestHandler {
  return async (req, _res, next) => {
    const me = await db.upsertProfile(userOf(req));
    if (me.role !== 'ADMIN') throw forbidden('Only administrators can open this.');
    next();
  };
}

/** What the dashboard shows of a journey: no coordinates, route, photo or tokens. */
const adminJourney = (j: Journey) => ({
  id: j.id,
  originName: j.originName,
  destinationName: j.destinationName,
  mode: j.mode,
  status: j.status,
  startedAt: j.startedAt,
  expectedArrival: j.expectedArrival,
  arrivedAt: j.arrivedAt,
  endedAt: j.endedAt,
  distanceKm: j.distanceKm,
  vehicle: j.vehicle,
  contactCount: j.contactIds.length,
});

const limitSchema = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(300) });
/** Newest journeys and notifications the activity view reads. */
const JOURNEY_LIMIT = 1000;
const NOTIFICATION_SCAN = 5000;

/**
 * Where the traveller was when it went out, by name: the coarse place of a progress
 * update, the start of a "started", the destination of an "arrived". Else unknown.
 */
function placeOf(n: AdminNotificationRow, j: Journey | undefined): string | null {
  if (n.place) return n.place;
  if (!j) return null;
  if (n.type === 'journey_started') return j.originName || null;
  if (n.type === 'journey_arrived') return j.destinationName || null;
  return null;
}

export function adminRoutes(db: Db): Router {
  const r = Router();
  r.use('/admin', requireAuth(db), requireAdmin(db));

  r.get('/admin/users', async (_req, res) => {
    res.json({ users: await db.listUsersForAdmin() });
  });

  /**
   * Who received what. Only the journey id and coarse place come from the stored
   * data; SOS coordinates and photo links are never sent.
   */
  r.get('/admin/notifications', async (req, res) => {
    const { limit } = parse(limitSchema, req.query);
    const [users, rows, journeys] = await Promise.all([
      db.listUsersForAdmin(),
      db.listNotificationsForAdmin(limit),
      db.listJourneysForAdmin(JOURNEY_LIMIT),
    ]);
    const who = new Map(users.map((u) => [u.id, u]));
    const trips = new Map(journeys.map((j) => [j.id, j]));
    res.json({
      notifications: rows.map((n) => {
        const recipient = who.get(n.userId);
        const j = n.journeyId ? trips.get(n.journeyId) : undefined;
        const traveller = j ? who.get(j.ownerId) : undefined;
        return {
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          read: n.read,
          createdAt: n.createdAt,
          recipient: { id: n.userId, name: recipient?.displayName ?? '', email: recipient?.email ?? null },
          journeyId: n.journeyId,
          traveller: j ? { id: j.ownerId, name: traveller?.displayName ?? '' } : null,
          place: placeOf(n, j),
        };
      }),
    });
  });

  /** Per user: how many journeys, and per journey how many notifications went out and from where. */
  r.get('/admin/journey-activity', async (_req, res) => {
    const [users, journeys, rows] = await Promise.all([
      db.listUsersForAdmin(),
      db.listJourneysForAdmin(JOURNEY_LIMIT),
      db.listNotificationsForAdmin(NOTIFICATION_SCAN),
    ]);
    const byJourney = new Map<string, AdminNotificationRow[]>();
    for (const n of rows) {
      if (!n.journeyId) continue;
      byJourney.set(n.journeyId, [...(byJourney.get(n.journeyId) ?? []), n]);
    }
    const trips = new Map(journeys.map((j) => [j.id, j]));
    res.json({
      users: users
        .map((u) => {
          const mine = journeys
            .filter((j) => j.ownerId === u.id)
            .map((j) => {
              const sent = byJourney.get(j.id) ?? [];
              return {
                ...adminJourney(j),
                notificationCount: sent.length,
                recipientCount: new Set(sent.map((n) => n.userId)).size,
                places: [...new Set(sent.map((n) => placeOf(n, trips.get(j.id))).filter((p): p is string => !!p))],
              };
            });
          return {
            id: u.id,
            name: u.displayName,
            email: u.email,
            countryCode: u.countryCode,
            journeyCount: u.journeys.total,
            notificationCount: mine.reduce((s, j) => s + j.notificationCount, 0),
            journeys: mine,
          };
        })
        .sort((a, b) => b.journeyCount - a.journeyCount || b.notificationCount - a.notificationCount),
    });
  });

  r.get('/admin/users/:id/journeys', async (req, res) => {
    const id = String(req.params.id);
    const users = await db.listUsersForAdmin();
    if (!users.some((u) => u.id === id)) throw notFound('User not found');
    const journeys = await db.listJourneys(id, { limit: 100 });
    res.json({ journeys: journeys.map(adminJourney) });
  });

  return r;
}
