import type { Db } from '../db/types.js';
import type { Profile } from '../types.js';
import { errorText, logError } from './log.js';
import { notifyUser } from './notify.js';

const MAX_NAME = 60;

/**
 * Tells every admin that someone has just signed in for the very first time (FR-NOT-15). It saves an in-app
 * notification for each admin and pushes it to their phones, like any other notification.
 *
 * The text names the person by display name only: no email, phone number or place, since a push goes through
 * a third party. A person who is already an admin is not told about themselves. It never throws, so a problem
 * here cannot stop anyone from signing in.
 */
export async function announceNewUser(db: Db, profile: Profile): Promise<void> {
  try {
    const admins = (await db.listAdminIds()).filter((id) => id !== profile.id);
    if (admins.length === 0) return;
    const name = profile.displayName.trim().slice(0, MAX_NAME);
    await Promise.all(
      admins.map((id) =>
        notifyUser(db, id, {
          type: 'new_user',
          title: 'New user joined Arrivo',
          body: name ? `${name} just signed up.` : 'Someone just signed up.',
          data: { userId: profile.id },
        }),
      ),
    );
  } catch (e) {
    logError(`[notify] could not tell the admins about a new user: ${errorText(e)}`);
  }
}
