import type { Db } from '../db/types.js';
import type { NewNotification } from '../types.js';

/**
 * Writes an in-app notification. A failure here must never break the action that
 * caused it (starting a journey, accepting an invite...), so errors are only logged.
 */
export async function notifyUser(db: Db, userId: string, n: NewNotification): Promise<void> {
  try {
    await db.createNotification(userId, n);
  } catch (e) {
    console.error('[notify] could not save a notification:', e instanceof Error ? e.message : 'unknown error');
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
    console.error('[notify] could not reach followers:', e instanceof Error ? e.message : 'unknown error');
  }
}

/** "6:45 PM" for a notification text (India time, since that is where trips happen). */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}
