import type { Db } from '../db/types.js';
import { errorText, logError, logInfo } from '../lib/log.js';
import { clock, notifyFollowers, notifyUser } from '../lib/notify.js';
import type { PlacesProvider } from '../lib/places.js';
import { describePlace, maybeSendProgress } from '../lib/progress.js';
import type { Journey, LocationPoint } from '../types.js';

/** No location for this long during a journey is reported (FR-TRK-22). */
export const STALE_AFTER_MS = 10 * 60_000;

export interface SweepResult {
  overdue: number;
  staleAlerts: number;
  checked: number;
}

/**
 * The scheduled check, every 5 minutes (Supabase pg_cron calls /v1/internal/sweep;
 * a long-running server runs it on a timer). It works when the phone has gone quiet,
 * which upload-triggered logic cannot:
 *  1. marks journeys past arrival + grace as overdue;
 *  2. when no location arrived for 10 minutes, tells the traveller and their contacts
 *     honestly, once per quiet spell, with the last place by name (never coordinates);
 *  3. sends a progress update that is due, from a recent location.
 * A paused share is expected silence, so it is not reported.
 */
export async function sweep(db: Db, places: PlacesProvider, nowMs = Date.now()): Promise<SweepResult> {
  const nowIso = new Date(nowMs).toISOString();
  const overdue = await db.markOverdue(nowIso);
  const journeys = await db.listOpenJourneysForSweep();
  let staleAlerts = 0;
  for (const j of journeys) {
    try {
      if (j.sharingPaused) continue;
      const last = await db.getLastLocation(j.id);
      const lastMs = last ? Date.parse(last.recordedAt) : Date.parse(j.startedAt);
      if (nowMs - lastMs >= STALE_AFTER_MS) {
        // Already told about this quiet spell: an alert newer than the last reading.
        if (j.staleAlertAt && Date.parse(j.staleAlertAt) >= lastMs) continue;
        if (!(await db.claimStaleAlert(j.id, j.staleAlertAt ?? null, nowIso))) continue;
        await alertStale(db, places, j, j.ownerId, last, nowMs - lastMs);
        staleAlerts++;
      } else if (last) {
        await maybeSendProgress(db, places, j, j.ownerId, [last], nowMs);
      }
    } catch (e) {
      logError(`[sweep] journey ${j.id} failed: ${errorText(e)}`);
    }
  }
  if (overdue > 0 || staleAlerts > 0) {
    logInfo(`[sweep] checked=${journeys.length} overdue=${overdue} staleAlerts=${staleAlerts}`);
  }
  return { overdue, staleAlerts, checked: journeys.length };
}

async function alertStale(
  db: Db,
  places: PlacesProvider,
  j: Journey,
  ownerId: string,
  last: LocationPoint | null,
  quietMs: number,
): Promise<void> {
  const minutes = Math.round(quietMs / 60_000);
  let where: string | null = null;
  if (last) {
    try {
      where = describePlace(await places.area(last.lat, last.lng), j.distanceKm);
    } catch {
      // Without a place name the alert still goes.
    }
  }
  const who = (await db.getDisplayName(ownerId)) || 'Someone';
  const lastSeen = last
    ? `Last update${where ? ` ${where}` : ''} at ${clock(last.recordedAt)}.`
    : 'No location has arrived since the journey started.';
  await notifyFollowers(db, ownerId, j.contactIds, {
    type: 'location_stale',
    title: `${who}'s location has not updated for ${minutes} min`,
    body: `${lastSeen} It may be weak signal, mobile data off or phone settings. You can call them.`,
    data: { journeyId: j.id, ...(where ? { place: where } : {}) },
  });
  await notifyUser(db, ownerId, {
    type: 'location_stale',
    title: 'Arrivo is not getting your location',
    body: 'Your contacts were told. Open Arrivo to keep sharing, or send your location by SMS.',
    data: { journeyId: j.id },
  });
}

/** For a long-running server: the same sweep on a timer. */
export function startSweepJob(db: Db, places: PlacesProvider, intervalMs = 5 * 60_000): () => void {
  const tick = async () => {
    try {
      await sweep(db, places);
    } catch (e) {
      logError(`[sweep] failed: ${errorText(e)}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
