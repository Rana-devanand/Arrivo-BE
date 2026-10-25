import type { Db } from '../db/types.js';
import type { NewNotification } from '../types.js';
import { errorText, logError, logInfo } from './log.js';
import { getPushSender } from './push.js';

/**
 * Writes an in-app notification and pushes it to the person's phones. A failure here
 * must never break the action that caused it (starting a journey, accepting an
 * invite...), so errors are only logged.
 */
export async function notifyUser(db: Db, userId: string, n: NewNotification): Promise<void> {
  try {
    await db.createNotification(userId, n);
  } catch (e) {
    logError(`[notify] could not save a notification: ${errorText(e)}`);
  }
  await pushToUser(db, userId, n);
}

async function pushToUser(db: Db, userId: string, n: NewNotification): Promise<void> {
  const sender = getPushSender();
  if (!sender) return;
  try {
    const tokens = await db.listPushTokens(userId);
    if (tokens.length === 0) {
      // The usual reason a contact got nothing: they never opened the app on a phone that registered.
      logInfo(`[push] skip type=${n.type} reason=no_devices`);
      return;
    }
    // Only short text fields go out: FCM data values must be strings, and the
    // in-app list already holds the full payload.
    const data: Record<string, string> = { type: n.type };
    for (const [k, v] of Object.entries(n.data ?? {})) {
      if (typeof v === 'string' && v.length <= 200) data[k] = v;
    }
    const dead = await sender.send(tokens, { title: n.title, body: n.body, data });
    await Promise.all(dead.map((t) => db.deletePushToken(t)));
    if (dead.length > 0) logInfo(`[push] removed ${dead.length} dead device(s)`);
  } catch (e) {
    logError(`[push] failed type=${n.type} reason=${errorText(e)}`);
  }
}

/** Tells everyone who follows this person (accepted contacts that have the app). */
export async function notifyFollowers(
  db: Db,
  ownerId: string,
  contactIds: string[] | undefined,
  n: NewNotification,
): Promise<void> {
  try {
    const ids = await db.listContactUserIds(ownerId, contactIds);
    await Promise.all(ids.map((id) => notifyUser(db, id, n)));
  } catch (e) {
    logError(`[notify] could not reach followers: ${errorText(e)}`);
  }
}

const IST = 'Asia/Kolkata';
const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: IST });

/**
 * "6:45 PM" for a notification text (India time, since that is where trips happen).
 * A trip that ends on another day says which: "Tomorrow, 6:45 PM" or "Tue 28 Oct, 6:45 PM".
 */
export function clock(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST });
  if (dayKey(at) === dayKey(now)) return time;
  if (dayKey(at) === dayKey(new Date(now.getTime() + 24 * 60 * 60 * 1000))) return `Tomorrow, ${time}`;
  const date = at.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: IST });
  return `${date}, ${time}`;
}
