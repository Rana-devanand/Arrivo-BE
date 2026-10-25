import { Router } from 'express';
import { z } from 'zod';

import { LIMITS, PLAN_NAMES, planOf } from '../domain/plans.js';
import type { Db } from '../db/types.js';
import { AppError, badRequest } from '../lib/errors.js';
import { requireAuth, userOf } from '../middleware/auth.js';
import { parse } from '../middleware/errors.js';

const saveSchema = z.object({
  name: z.string().trim().min(1, 'Give the household a name').max(40),
  contactIds: z.array(z.string().min(1)).max(LIMITS.plus.contacts),
});

/**
 * The Family household: a name and some of the person's contacts, so a whole family can be
 * picked for a journey in one tap. Creating and changing it is part of Arrivo Plus.
 */
export function householdRoutes(db: Db): Router {
  const r = Router();
  r.use(requireAuth(db));

  r.get('/household', async (req, res) => {
    const user = userOf(req);
    const plan = await planOf(db, user.id);
    // A household made while on Plus stays visible after the plan ends, but cannot be edited.
    res.json({ allowed: LIMITS[plan].household, household: await db.getHousehold(user.id) });
  });

  r.put('/household', async (req, res) => {
    const user = userOf(req);
    const plan = await planOf(db, user.id);
    if (!LIMITS[plan].household) {
      throw new AppError(403, 'plan_required', `The Family household is part of ${PLAN_NAMES.plus}.`, { needs: 'plus' });
    }
    const body = parse(saveSchema, req.body);
    const mine = new Set((await db.listContacts(user.id)).map((c) => c.id));
    for (const id of body.contactIds) {
      if (!mine.has(id)) throw badRequest('One of the people you chose is not in your contacts.');
    }
    res.json({ household: await db.saveHousehold(user.id, body.name, body.contactIds) });
  });

  /** Anyone can remove their household, on any plan. */
  r.delete('/household', async (req, res) => {
    await db.deleteHousehold(userOf(req).id);
    res.status(204).end();
  });

  return r;
}
