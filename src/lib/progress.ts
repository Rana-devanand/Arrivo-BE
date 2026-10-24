import type { Db } from '../db/types.js';
import type { Journey, LocationPoint } from '../types.js';
import { clock, notifyFollowers } from './notify.js';
import type { AreaInfo, PlacesProvider } from './places.js';

/** Trips shorter than this (km) are described by road and area, longer ones by city and state. */
export const LOCAL_TRIP_KM = 30;

/** A position older than this is not shown as "where they are now". */
const FRESH_MS = 10 * 60_000;

const usable = (s: string | undefined): s is string => !!s && !/^unnamed road$/i.test(s.trim());

/**
 * Words for where the traveller is, matched to how far the trip goes (never a
 * house number, shop, hotel or restaurant name):
 *  - local trip: "near MG Road, Koregaon Park" (a road is something contacts know)
 *  - long trip:  "near Nashik, Maharashtra" (a road means little in another state)
 * Returns null when nothing usable is known.
 */
export function describePlace(area: AreaInfo, tripKm: number): string | null {
  // An unknown trip length is treated as long: the coarser text reveals less.
  const local = tripKm > 0 && tripKm < LOCAL_TRIP_KM;
  if (local) {
    const road = usable(area.road) ? area.road : undefined;
    const where = [road, area.neighbourhood ?? area.city].filter(usable);
    if (where.length > 0) return `near ${where.join(', ')}`;
  }
  const far = [area.city ?? area.neighbourhood, area.state].filter(usable);
  return far.length > 0 ? `near ${far.join(', ')}` : null;
}

/** Newest of the uploaded points, if it is recent enough to call "now". */
function freshest(points: LocationPoint[], nowMs: number): LocationPoint | null {
  const latest = [...points].sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];
  return latest && nowMs - Date.parse(latest.recordedAt) <= FRESH_MS ? latest : null;
}

/**
 * Sends the traveller's chosen "on the way" update to their contacts when one
 * interval has passed since the last one (or since the start).
 *
 * It runs when the phone uploads its location, so it needs no timer or cron job
 * (works on serverless hosting) and only fires while the phone is really sharing.
 *
 * The text names a coarse place (see [describePlace]) and never coordinates
 * (FR-NOT-11). The contact taps it to see the live location inside the app.
 *
 * A failure here must never break the location upload, so errors are only logged.
 */
export async function maybeSendProgress(
  db: Db,
  places: PlacesProvider,
  journey: Journey,
  ownerId: string,
  uploaded: LocationPoint[],
  nowMs = Date.now(),
): Promise<void> {
  try {
    const minutes = journey.updateIntervalMinutes;
    if (!minutes || journey.status !== 'active') return;
    const last = Date.parse(journey.lastProgressAt ?? journey.startedAt);
    if (nowMs - last < minutes * 60_000) return;
    if (!(await db.claimProgressUpdate(journey.id, journey.lastProgressAt, new Date(nowMs).toISOString()))) return;

    let where: string | null = null;
    const point = freshest(uploaded, nowMs);
    if (point) {
      try {
        where = describePlace(await places.area(point.lat, point.lng), journey.distanceKm);
      } catch {
        // No place service or it failed: the update still goes, without a place.
      }
    }

    const who = (await db.getDisplayName(ownerId)) || 'Someone';
    await notifyFollowers(db, ownerId, journey.contactIds, {
      type: 'journey_progress',
      title: where ? `${who} is ${where}` : `${who} is on the way`,
      body: `Heading to ${journey.destinationName}, arriving ${clock(journey.expectedArrival)}. Tap to see the live map.`,
      data: { journeyId: journey.id },
    });
  } catch (e) {
    console.error('[progress] could not send an update:', e instanceof Error ? e.message : 'unknown error');
  }
}
