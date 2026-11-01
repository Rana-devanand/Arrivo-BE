import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db/types.js';
import { FAMILY_MEMBERS, hasPlus, isFamilySub } from '../domain/plans.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { requireAuth, userOf } from '../middleware/auth.js';
import { parse } from '../middleware/errors.js';
import type { FamilyMember } from '../types.js';

const emailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });

/** Taken places: invitations still waiting and members who accepted. */
const holdsPlace = (m: FamilyMember) => m.status === 'invited' || m.status === 'accepted';

const view = (m: FamilyMember) => ({
  id: m.id,
  email: m.email,
  status: m.status,
  createdAt: m.createdAt,
  acceptedAt: m.acceptedAt,
});

/**
 * Arrivo Plus Family (FR-BIL-10): the owner pays once a year and shares Plus with
 * up to 2 people, invited by email. A member gets Plus only after accepting, and
 * only while the owner's plan is paid. Accepted members stay for the whole year;
 * only invitations nobody answered can be withdrawn.
 */
export function familyRoutes(db: Db): Router {
  const r = Router();
  r.use('/family', requireAuth(db));

  async function ownerPlan(userId: string) {
    const sub = await db.getSubscription(userId);
    return hasPlus(sub) && isFamilySub(sub) ? sub : null;
  }

  /** The owner's members, and how many places are left. */
  r.get('/family', async (req, res) => {
    const me = userOf(req);
    const sub = await ownerPlan(me.id);
    const members = (await db.listFamilyMembers(me.id)).filter(holdsPlace);
    res.json({
      owner: sub !== null,
      places: FAMILY_MEMBERS,
      renewsAt: sub?.currentPeriodEnd ?? null,
      members: members.map(view),
    });
  });

  r.post('/family/members', async (req, res) => {
    const me = userOf(req);
    if (!(await ownerPlan(me.id))) throw forbidden('Only the owner of Arrivo Plus Family can add members.');
    const { email } = parse(emailSchema, req.body);
    if (email === me.email?.toLowerCase()) throw badRequest('That is your own email. Invite someone else.');
    const taken = (await db.listFamilyMembers(me.id)).filter(holdsPlace);
    if (taken.some((m) => m.email === email)) throw conflict('This person is already invited.');
    if (taken.length >= FAMILY_MEMBERS) {
      throw conflict(`Arrivo Plus Family is for you and ${FAMILY_MEMBERS} people. Both places are taken.`);
    }
    res.status(201).json(view(await db.addFamilyMember(me.id, email)));
  });

  /** Withdraw an invitation nobody answered. Accepted members stay for the year. */
  r.delete('/family/members/:id', async (req, res) => {
    const me = userOf(req);
    const m = await db.getFamilyMember(String(req.params.id));
    if (!m || m.ownerId !== me.id) throw notFound('Member not found');
    if (m.status === 'accepted') throw conflict('Members who accepted stay on your plan until it ends.');
    const cancelled = await db.cancelFamilyInvite(me.id, m.id);
    if (!cancelled) throw conflict('This invitation was already answered.');
    res.json(view(cancelled));
  });

  /** Invitations waiting for the signed-in person's verified email. */
  r.get('/family/invites', async (req, res) => {
    const me = userOf(req);
    if (!me.email || !me.emailVerified) return void res.json({ invites: [] });
    const invites = await db.listFamilyInvitesByEmail(me.email);
    const live = [];
    for (const i of invites) {
      if (!(await ownerPlan(i.ownerId))) continue; // the owner's plan ended
      live.push({ id: i.id, ownerName: (await db.getDisplayName(i.ownerId)) || 'Someone', createdAt: i.createdAt });
    }
    res.json({ invites: live });
  });

  r.post('/family/invites/:id/:answer', async (req, res) => {
    const me = userOf(req);
    const answer = String(req.params.answer);
    if (answer !== 'accept' && answer !== 'decline') throw notFound();
    const invite = await db.getFamilyMember(String(req.params.id));
    // Only the person the invitation was sent to, with a confirmed address.
    if (!invite || !me.email || invite.email !== me.email.toLowerCase()) throw notFound('Invitation not found');
    if (!me.emailVerified) throw forbidden('Confirm your email address first.');
    if (invite.status !== 'invited') throw conflict('This invitation was already answered.');
    if (answer === 'accept') {
      if (invite.ownerId === me.id) throw badRequest('You cannot join your own plan.');
      if (await db.getFamilyMembershipOf(me.id)) throw conflict('You are already in an Arrivo Plus Family.');
      if (!(await ownerPlan(invite.ownerId))) throw conflict('This Arrivo Plus Family has ended.');
      const accepted = (await db.listFamilyMembers(invite.ownerId)).filter((m) => m.status === 'accepted');
      if (accepted.length >= FAMILY_MEMBERS) throw conflict('This Arrivo Plus Family is already full.');
    }
    const done = await db.answerFamilyInvite(invite.id, me.id, answer === 'accept' ? 'accepted' : 'declined');
    if (!done) throw conflict('This invitation was already answered.');
    res.json(view(done));
  });

  return r;
}
