import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import type { Db } from '../db/types.js';
import { badRequest, conflict, gone, notFound } from '../lib/errors.js';
import { isValidInviteCode, normalizeInviteCode } from '../lib/inviteCode.js';
import { requireAuth, userOf } from '../middleware/auth.js';
import { notifyUser } from '../lib/notify.js';
import type { InviteInfo } from '../types.js';

/**
 * The invited person opens Arrivo, signs in, and enters the invite code they
 * were sent. Accepting links their account to the contact, which is what lets
 * them follow journeys.
 */
export function invitationRoutes(db: Db): Router {
  const r = Router();
  // Codes are guessable only by brute force, so make that slow.
  r.use('/invitations', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }));
  r.use(requireAuth(db));

  async function load(code: string, userId: string): Promise<InviteInfo> {
    const normalized = normalizeInviteCode(code);
    if (!isValidInviteCode(normalized)) throw notFound('Invitation not found. Check the code and try again.');
    const info = await db.getInviteByCode(normalized);
    if (!info) throw notFound('Invitation not found. Check the code and try again.');
    if (info.ownerId === userId) {
      throw badRequest('This is your own invitation. Send the code to the person you invited.');
    }
    if (info.contact.status === 'removed') throw gone('This invitation was withdrawn.');
    if (info.contactUserId && info.contactUserId !== userId) throw conflict('This invitation was already used.');
    return info;
  }

  /** Invitations sent to the email I signed in with, so I do not need a code. */
  r.get('/invitations/pending', async (req, res) => {
    const user = userOf(req);
    if (!user.email || !user.emailVerified) return void res.json({ items: [] });
    const found = await db.listPendingInvitesByEmail(user.email, user.id);
    const items = await Promise.all(
      found.map(async (i) => ({
        inviteCode: i.contact.inviteCode,
        inviterName: (await db.getDisplayName(i.ownerId)) || 'Someone',
      })),
    );
    res.json({ items: items.filter((i) => i.inviteCode) });
  });

  r.get('/invitations/:code', async (req, res) => {
    const user = userOf(req);
    const info = await load(String(req.params.code), user.id);
    const inviter = await db.getDisplayName(info.ownerId);
    res.json({ inviterName: inviter || 'Someone', contactName: info.contact.name, status: info.contact.status });
  });

  const answer = (status: 'accepted' | 'declined') => async (req: import('express').Request, res: import('express').Response) => {
    const user = userOf(req);
    const info = await load(String(req.params.code), user.id);
    const inviter = (await db.getDisplayName(info.ownerId)) || 'Someone';
    if (info.contact.status === status && info.contactUserId === user.id) {
      return void res.json({ status, inviterName: inviter }); // repeat is fine
    }
    const updated = await db.answerInvite(info.contact.id, user.id, status);
    if (!updated) throw notFound('Invitation not found');
    const me = (await db.getDisplayName(user.id)) || user.displayName || 'Someone';
    await notifyUser(db, info.ownerId, {
      type: status === 'accepted' ? 'invite_accepted' : 'invite_declined',
      title: status === 'accepted' ? `${me} accepted your invitation` : `${me} declined your invitation`,
      body: status === 'accepted' ? 'They can now follow your journeys.' : 'They will not follow your journeys.',
      data: { contactId: info.contact.id },
    });
    res.json({ status: updated.status, inviterName: inviter });
  };
  r.post('/invitations/:code/accept', answer('accepted'));
  r.post('/invitations/:code/decline', answer('declined'));

  /** People who invited me and I accepted: "I am a trusted contact of ...". */
  r.get('/trusting', async (req, res) => {
    const rows = await db.listTrustedBy(userOf(req).id);
    const photos = await db.getAvatarUrls(rows.map((t) => t.ownerId));
    const items = await Promise.all(
      rows.map(async (t) => ({
        name: (await db.getDisplayName(t.ownerId)) || 'Someone',
        avatarUrl: photos.get(t.ownerId) ?? null,
        since: t.since,
      })),
    );
    res.json({ items });
  });

  /** Journeys other people shared with you. */
  r.get('/following', async (req, res) => {
    res.json({ items: await db.listFollowing(userOf(req).id) });
  });

  return r;
}
