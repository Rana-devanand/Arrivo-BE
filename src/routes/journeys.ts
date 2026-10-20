import { randomBytes } from 'node:crypto';

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { isFinal, isOpen, validateArrival } from '../domain/journeyRules.js';
import type { Db } from '../db/types.js';
import type { Cloudinary } from '../lib/cloudinary.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { clock, notifyFollowers } from '../lib/notify.js';
import { requireAuth, userOf } from '../middleware/auth.js';
import { parse } from '../middleware/errors.js';
import type { Journey, JourneyStatus } from '../types.js';

const createSchema = z.object({
  destinationName: z.string().trim().min(1).max(160),
  destinationLat: z.number().min(-90).max(90).nullable().optional(),
  destinationLng: z.number().min(-180).max(180).nullable().optional(),
  originName: z.string().trim().max(160).default('Current location'),
  mode: z.enum(['walk', 'bike', 'car', 'transit', 'train', 'metro']).default('car'),
  originLat: z.number().min(-90).max(90).nullable().optional(),
  originLng: z.number().min(-180).max(180).nullable().optional(),
  distanceKm: z.number().min(0).max(5000).default(0),
  /** The planned route as one encoded polyline. */
  routePolyline: z.string().max(40_000).nullable().optional(),
  routeSteps: z
    .array(
      z.object({
        kind: z.string().max(20),
        label: z.string().max(160),
        distanceMeters: z.number().min(0),
        durationSeconds: z.number().min(0),
        from: z.string().max(160).optional(),
        to: z.string().max(160).optional(),
      }),
    )
    .max(40)
    .nullable()
    .optional(),
  /** Cloudinary photo of the number plate or ride, from POST /journeys/photo-ticket. */
  vehicleImageUrl: z.string().url().max(500).nullable().optional(),
  expectedArrival: z.string().datetime({ offset: true }),
  contactIds: z.array(z.string().min(1)).min(1).max(20),
  vehicle: z.string().trim().max(120).default(''),
  note: z.string().trim().max(500).default(''),
  lateCheckIn: z.boolean().default(true),
  graceMinutes: z.number().int().min(1).max(60).default(10),
  autoArrival: z.boolean().default(true),
  notifyOnStart: z.boolean().default(true),
  createWatchLink: z.boolean().default(false),
});

const listSchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().datetime({ offset: true }).optional(),
});

const etaSchema = z.object({ expectedArrival: z.string().datetime({ offset: true }) });

export const pointsSchema = z.object({
  points: z
    .array(
      z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracy: z.number().min(0).max(100000).nullable().optional(),
        speed: z.number().min(0).max(400).nullable().optional(),
        recordedAt: z.string().datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(100),
});

const STATUSES: JourneyStatus[] = ['active', 'overdue', 'completed', 'cancelled'];

export function journeyRoutes(db: Db, opts: { watchBaseUrl: string; photos: Cloudinary }): Router {
  const r = Router();
  r.use(requireAuth(db));

  async function createLink(journey: Journey, ownerId: string) {
    const token = randomBytes(16).toString('base64url');
    const expiresAt = new Date(new Date(journey.expectedArrival).getTime() + 24 * 60 * 60 * 1000).toISOString();
    const link = await db.createWatchLink({ token, journeyId: journey.id, ownerId, expiresAt });
    return { token: link.token, url: `${opts.watchBaseUrl}/${link.token}`, expiresAt: link.expiresAt };
  }

  /** A signed permit to upload a photo of the number plate / ride to Cloudinary. */
  r.post('/journeys/photo-ticket', (req, res) => {
    res.json(opts.photos.ticket(userOf(req).id, 'plate'));
  });

  /** Start a journey. Only accepted contacts can follow; one journey at a time. */
  r.post('/journeys', async (req, res) => {
    const user = userOf(req);
    const body = parse(createSchema, req.body);

    const arrivalError = validateArrival(body.expectedArrival);
    if (arrivalError) throw badRequest(arrivalError);

    if (body.vehicleImageUrl && !opts.photos.isOwnPlate(body.vehicleImageUrl, user.id)) {
      throw badRequest('That photo is not valid. Attach it again from the app.');
    }

    const existing = await db.getOpenJourney(user.id);
    if (existing) throw conflict('You already have a journey in progress', { journeyId: existing.id });

    const contactIds = [...new Set(body.contactIds)];
    const contacts = await db.listContacts(user.id);
    for (const id of contactIds) {
      const c = contacts.find((x) => x.id === id);
      if (!c) throw badRequest('One of the selected contacts was not found');
      if (c.status !== 'accepted') throw badRequest(`${c.name} has not accepted your invitation yet`);
    }

    const journey = await db.createJourney(user.id, {
      destinationName: body.destinationName,
      destinationLat: body.destinationLat ?? null,
      destinationLng: body.destinationLng ?? null,
      originName: body.originName,
      mode: body.mode,
      expectedArrival: body.expectedArrival,
      vehicle: body.vehicle,
      note: body.note,
      lateCheckIn: body.lateCheckIn,
      graceMinutes: body.graceMinutes,
      autoArrival: body.autoArrival,
      notifyOnStart: body.notifyOnStart,
      distanceKm: body.distanceKm,
      originLat: body.originLat ?? null,
      originLng: body.originLng ?? null,
      routePolyline: body.routePolyline ?? null,
      routeSteps: body.routeSteps ?? null,
      vehicleImageUrl: body.vehicleImageUrl ?? null,
      trackToken: randomBytes(24).toString('base64url'),
      contactIds,
    });
    const watch = body.createWatchLink ? await createLink(journey, user.id) : null;
    // Tell the chosen contacts, and share the ride photo as its own item they can open.
    if (body.notifyOnStart) {
      const who = (await db.getDisplayName(user.id)) || user.displayName || 'Someone';
      await notifyFollowers(db, user.id, contactIds, {
        type: 'journey_started',
        title: `${who} started a journey`,
        body: `To ${journey.destinationName} · arriving ${clock(journey.expectedArrival)}${journey.vehicle ? ` · ${journey.vehicle}` : ''}`,
        data: { journeyId: journey.id },
      });
      if (journey.vehicleImageUrl) {
        await notifyFollowers(db, user.id, contactIds, {
          type: 'attachment',
          title: `${who} shared a ride photo`,
          body: journey.vehicle ? `Number plate: ${journey.vehicle}` : 'Check that it is the right ride.',
          data: { journeyId: journey.id, imageUrl: journey.vehicleImageUrl },
        });
      }
    }
    // Contact notifications are sent by the notification service (not built yet).
    res.status(201).json({ ...journey, watch });
  });

  r.get('/journeys/active', async (req, res) => {
    const j = await db.getOpenJourney(userOf(req).id);
    if (!j) throw notFound('No journey in progress');
    res.json(j);
  });

  r.get('/journeys', async (req, res) => {
    const q = parse(listSchema, req.query);
    let status: JourneyStatus[] | undefined;
    if (q.status) {
      status = q.status.split(',').map((s) => s.trim()) as JourneyStatus[];
      if (status.some((s) => !STATUSES.includes(s))) throw badRequest('Unknown status filter');
    }
    const rows = await db.listJourneys(userOf(req).id, { status, limit: q.limit, before: q.before });
    res.json({
      items: rows,
      nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.startedAt : null,
    });
  });

  r.get('/journeys/:id', async (req, res) => {
    const j = await db.getJourney(userOf(req).id, String(req.params.id));
    if (!j) throw notFound('Journey not found');
    res.json(j);
  });

  /** Change the arrival time. Also clears an overdue state ("I am fine"). */
  r.patch('/journeys/:id', async (req, res) => {
    const user = userOf(req);
    const id = String(req.params.id);
    const { expectedArrival } = parse(etaSchema, req.body);
    const err = validateArrival(expectedArrival);
    if (err) throw badRequest(err);
    const updated = await db.updateJourney(user.id, id, { expectedArrival, status: 'active' }, ['active', 'overdue']);
    if (updated) {
      const who = (await db.getDisplayName(user.id)) || user.displayName || 'Someone';
      await notifyFollowers(db, user.id, updated.contactIds, {
        type: 'journey_delayed',
        title: `${who} is running late`,
        body: `New arrival time ${clock(updated.expectedArrival)}`,
        data: { journeyId: updated.id },
      });
      return void res.json(updated);
    }
    const j = await db.getJourney(user.id, id);
    if (!j) throw notFound('Journey not found');
    throw conflict('This journey has already ended');
  });

  // Idempotent: repeating complete/cancel returns the same result (FR-JRN-03).
  const finish = (target: 'completed' | 'cancelled') =>
    async (req: Request, res: Response) => {
      const user = userOf(req);
      const id = String(req.params.id);
      const now = new Date().toISOString();
      const patch = target === 'completed' ? { status: target, arrivedAt: now, endedAt: now } : { status: target, endedAt: now };
      const updated = await db.updateJourney(user.id, id, patch, ['active', 'overdue']);
      if (updated) {
        await db.revokeWatchLinks(id, user.id).catch(() => undefined);
        const who = (await db.getDisplayName(user.id)) || user.displayName || 'Someone';
        await notifyFollowers(db, user.id, updated.contactIds, {
          type: target === 'completed' ? 'journey_arrived' : 'journey_cancelled',
          title: target === 'completed' ? `${who} arrived safely` : `${who} cancelled the journey`,
          body: target === 'completed' ? `Reached ${updated.destinationName}` : `The trip to ${updated.destinationName} was cancelled.`,
          data: { journeyId: updated.id },
        });
        return void res.json(updated);
      }
      const j = await db.getJourney(user.id, id);
      if (!j) throw notFound('Journey not found');
      if (j.status === target) return void res.json(j);
      throw conflict(`This journey was already ${j.status}`);
    };
  r.post('/journeys/:id/complete', finish('completed'));
  r.post('/journeys/:id/cancel', finish('cancelled'));

  r.post('/journeys/:id/location', async (req, res) => {
    const user = userOf(req);
    const id = String(req.params.id);
    const { points } = parse(pointsSchema, req.body);
    const j = await db.getJourney(user.id, id);
    if (!j) throw notFound('Journey not found');
    if (!isOpen(j.status)) throw conflict('Location is only shared while a journey is in progress');

    const limit = Date.now() + 5 * 60_000;
    const sane = points.filter((p) => new Date(p.recordedAt).getTime() <= limit);
    if (sane.length === 0) throw badRequest('Location timestamps are in the future');
    await db.addLocationPoints(id, sane);
    res.status(202).json({ accepted: sane.length });
  });

  r.post('/journeys/:id/watch-link', async (req, res) => {
    const user = userOf(req);
    const j = await db.getJourney(user.id, String(req.params.id));
    if (!j) throw notFound('Journey not found');
    if (isFinal(j.status)) throw conflict('This journey has ended');
    res.status(201).json(await createLink(j, user.id));
  });

  r.delete('/journeys/:id/watch-link', async (req, res) => {
    const user = userOf(req);
    const id = String(req.params.id);
    if (!(await db.getJourney(user.id, id))) throw notFound('Journey not found');
    await db.revokeWatchLinks(id, user.id);
    res.status(204).end();
  });

  return r;
}

