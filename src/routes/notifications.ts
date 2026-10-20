import { Router } from 'express';
import { z } from 'zod';

import type { Db } from '../db/types.js';
import { requireAuth, userOf } from '../middleware/auth.js';
import { parse } from '../middleware/errors.js';
import type { AppNotification } from '../types.js';

const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(40) });
const readSchema = z.object({ ids: z.array(z.string().min(1)).max(200).optional() });

/**
 * Everything that happened that the person should know about: invitations waiting
 * for an answer (found by their sign-in email) and events stored for them.
 */
export function notificationRoutes(db: Db): Router {
  const r = Router();
  r.use(requireAuth(db));

  /** Invitations sent to my email that I have not answered. They are not stored; they are looked up. */
  async function pendingInvites(userId: string, email: string | null, verified: boolean): Promise<AppNotification[]> {
    if (!email || !verified) return [];
    const found = await db.listPendingInvitesByEmail(email, userId);
    const out: AppNotification[] = [];
    for (const i of found) {
      if (!i.contact.inviteCode) continue;
      const inviter = (await db.getDisplayName(i.ownerId)) || 'Someone';
      out.push({
        id: `invite:${i.contact.inviteCode}`,
        type: 'invitation',
        title: `${inviter} invited you`,
        body: 'Accept to follow their journeys and know they arrived safely.',
        data: { inviteCode: i.contact.inviteCode, inviterName: inviter },
        read: false,
        createdAt: i.contact.createdAt,
      });
    }
    return out;
  }

  r.get('/notifications', async (req, res) => {
    const user = userOf(req);
    const { limit } = parse(listSchema, req.query);
    const [invites, stored, unread] = await Promise.all([
      pendingInvites(user.id, user.email, user.emailVerified),
      db.listNotifications(user.id, limit),
      db.countUnreadNotifications(user.id),
    ]);
    res.json({ items: [...invites, ...stored], unread: unread + invites.length });
  });

  r.get('/notifications/unread-count', async (req, res) => {
    const user = userOf(req);
    const [invites, unread] = await Promise.all([
      pendingInvites(user.id, user.email, user.emailVerified),
      db.countUnreadNotifications(user.id),
    ]);
    res.json({ unread: unread + invites.length });
  });

  /** Mark some (or all, when no ids are sent) as read. */
  r.post('/notifications/read', async (req, res) => {
    const { ids } = parse(readSchema, req.body ?? {});
    await db.markNotificationsRead(userOf(req).id, ids);
    res.status(204).end();
  });

  return r;
}
