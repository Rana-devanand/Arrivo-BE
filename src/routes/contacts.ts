import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db/types.js';
import { LIMITS, PLAN_NAMES, planOf } from '../domain/plans.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { newInviteCode } from '../lib/inviteCode.js';
import type { Mailer } from '../lib/mailer.js';
import { requireAuth, userOf } from '../middleware/auth.js';
import type { AuthUser, Contact } from '../types.js';
import { parse } from '../middleware/errors.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number')
    .optional(),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
});

/** Compares the last 10 digits so "+91 98765 43210" equals "09876543210". */
function sameNumber(a: string, b: string): boolean {
  const da = a.replace(/\D/g, '').slice(-10);
  const dn = b.replace(/\D/g, '').slice(-10);
  return da.length >= 7 && da === dn;
}

export function contactRoutes(db: Db, opts: { devRoutes: boolean; mailer: Mailer }): Router {
  const r = Router();
  r.use(requireAuth(db));

  async function sendInvite(user: AuthUser, c: Contact): Promise<boolean> {
    if (!c.email || !c.inviteCode) return false;
    const inviterName = (await db.getDisplayName(user.id)) || user.displayName || 'A friend';
    return opts.mailer.sendInvite({ to: c.email, inviterName, contactName: c.name, code: c.inviteCode });
  }

  r.get('/contacts', async (req, res) => {
    res.json({ items: await db.listContacts(userOf(req).id) });
  });

  r.post('/contacts', async (req, res) => {
    const body = parse(createSchema, req.body);
    if (!body.phone && !body.email) throw badRequest('Add a phone number or an email');
    const me = userOf(req);
    // You cannot invite yourself (your own email or your own phone number).
    if (body.email && me.email && body.email.toLowerCase() === me.email.toLowerCase()) {
      throw badRequest('That is your own email address. Invite someone else.');
    }
    if (body.phone) {
      const mine = (await db.upsertProfile(me)).phone;
      if (mine && sameNumber(mine, body.phone)) {
        throw badRequest('That is your own phone number. Invite someone else.');
      }
    }
    // Arrivo Free has room for one contact; Plus has more. People who already have more
    // keep them, they just cannot add another.
    const plan = await planOf(db, me.id);
    const have = (await db.listContacts(me.id)).length;
    if (have >= LIMITS[plan].contacts) {
      throw new AppError(
        403,
        'plan_limit',
        plan === 'free'
          ? `${PLAN_NAMES.free} lets you add ${LIMITS.free.contacts} contact. Upgrade to ${PLAN_NAMES.plus} to add more.`
          : `You can have up to ${LIMITS.plus.contacts} contacts. Remove one to add another.`,
        { plan, limit: LIMITS[plan].contacts },
      );
    }
    const contact = await db.createContact(userOf(req).id, {
      name: body.name,
      phone: body.phone ?? null,
      email: body.email ?? null,
      inviteCode: newInviteCode(),
    });
    const emailSent = contact.email ? await sendInvite(userOf(req), contact) : false;
    res.status(201).json({ ...contact, emailSent });
  });

  /** Remove a contact. They immediately lose access to any journey in progress. */
  r.delete('/contacts/:id', async (req, res) => {
    const user = userOf(req);
    const id = String(req.params.id);
    const existing = await db.getContact(user.id, id);
    if (!existing || existing.status === 'removed') throw notFound('Contact not found');
    await db.removeContactFromOpenJourneys(user.id, id);
    await db.updateContactStatus(user.id, id, 'removed');
    res.status(204).end();
  });

  r.post('/contacts/:id/resend', async (req, res) => {
    const existing = await db.getContact(userOf(req).id, String(req.params.id));
    if (!existing || existing.status !== 'invited') throw notFound('No pending invitation for this contact');
    // Email goes out when the contact has one. SMS is not built yet, so the app
    // also shows the code to share by hand.
    const emailSent = await sendInvite(userOf(req), existing);
    res.json({ inviteCode: existing.inviteCode, emailSent });
  });

  if (opts.devRoutes) {
    /**
     * DEV ONLY: marks a contact as accepted so journeys can be tested before the
     * invitation flow exists. Never enabled in production (see config).
     */
    r.post('/dev/contacts/:id/accept', async (req, res) => {
      const c = await db.updateContactStatus(userOf(req).id, String(req.params.id), 'accepted');
      if (!c) throw notFound('Contact not found');
      res.json(c);
    });
  }

  return r;
}
