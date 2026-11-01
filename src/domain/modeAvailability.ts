import { haversine, type LatLng } from '../lib/polyline.js';
import type { PlanMode, Station } from '../lib/routing.js';

/**
 * Whether a way of travelling works for a trip (SRS FR-JRN-11).
 *
 * "unavailable" is only said on evidence: no station at all, the same station at both
 * ends, or two different metro networks. Missing data (a failed search, no timetable)
 * is never proof, so it gives "estimate" instead. State or country lists are not used:
 * trains cross states and metros are city networks that cross state lines.
 */
export type AvailabilityStatus = 'available' | 'estimate' | 'unavailable';

export interface ModeAvailability {
  mode: PlanMode;
  status: AvailabilityStatus;
  /** Plain words for the traveller, e.g. "No metro station near your destination." */
  reason?: string;
  /** The check itself failed; asking again may give a better answer. */
  retry?: boolean;
}

/** Stations found near a place, and whether every search for them failed. */
export interface StationLookup {
  stations: Station[];
  failed: boolean;
}

/** A metro station further than this from either end does not serve the trip. */
export const METRO_REACH_M = 15_000;
/** Metro stations further apart than this are in different cities' networks. */
export const METRO_NETWORK_M = 60_000;
/** Closer than this, two stations are the same place. */
const SAME_STATION_M = 300;

const word = (mode: 'train' | 'metro') => (mode === 'train' ? 'train' : 'metro');
const km = (m: number) => `${Math.round(m / 1000)} km`;

/** The arrival station the app will pick: the nearest one that is not the boarding station. */
export function alightingStation(board: Station, alight: Station[]): Station | undefined {
  return alight.find((s) => s.name !== board.name && haversine(s, board) >= SAME_STATION_M);
}

/** Last part of a Google address, e.g. "India". Empty when unknown. */
const countryOf = (s: Station) => s.address.split(',').pop()?.trim() ?? '';

/**
 * Decides from the stations alone. Returns a final answer, or the two stations whose
 * ride still has to be looked up.
 */
export function judgeStations(
  mode: 'train' | 'metro',
  board: StationLookup,
  alight: StationLookup,
): ModeAvailability | { board: Station; alight: Station } {
  const w = word(mode);
  if ((board.failed && board.stations.length === 0) || (alight.failed && alight.stations.length === 0)) {
    return {
      mode,
      status: 'estimate',
      retry: true,
      reason: `We could not check for ${w} stations right now, so this is an estimate.`,
    };
  }
  const wide = mode === 'train' ? ', even after searching a wide area' : '';
  const b = board.stations[0];
  if (!b) return { mode, status: 'unavailable', reason: `No ${w} station near your starting point${wide}.` };
  if (alight.stations.length === 0) {
    return { mode, status: 'unavailable', reason: `No ${w} station near your destination${wide}.` };
  }
  if (mode === 'metro' && b.distanceMeters > METRO_REACH_M) {
    return { mode, status: 'unavailable', reason: `The nearest metro station is ${km(b.distanceMeters)} from your start.` };
  }
  const a = alightingStation(b, alight.stations);
  if (!a) {
    return {
      mode,
      status: 'unavailable',
      reason: `Your start and destination use the same ${w} station, so it would not help for this trip.`,
    };
  }
  if (mode === 'metro' && a.distanceMeters > METRO_REACH_M) {
    return {
      mode,
      status: 'unavailable',
      reason: `The nearest metro station is ${km(a.distanceMeters)} from your destination.`,
    };
  }
  if (mode === 'metro' && haversine(b, a) > METRO_NETWORK_M) {
    return { mode, status: 'unavailable', reason: 'The metro does not connect these two cities.' };
  }
  return { board: b, alight: a };
}

/** After looking for the ride between the two stations. */
export function judgeRide(
  mode: 'train' | 'metro',
  stations: { board: Station; alight: Station },
  rideFound: boolean,
): ModeAvailability {
  if (rideFound) return { mode, status: 'available' };
  const crossBorder =
    mode === 'train' &&
    countryOf(stations.board) !== '' &&
    countryOf(stations.alight) !== '' &&
    countryOf(stations.board) !== countryOf(stations.alight);
  return {
    mode,
    status: 'estimate',
    reason: crossBorder
      ? 'This trip crosses a border. Check that trains run between these countries.'
      : `We found ${word(mode)} stations at both ends but no timetable, so times are estimates. Check before you leave.`,
  };
}

/** Every mode for a trip. Road modes are always offered; their plan says if no road route exists. */
export async function checkAvailability(
  origin: LatLng,
  destination: LatLng,
  find: (near: LatLng, mode: 'train' | 'metro') => Promise<StationLookup>,
  ride: (from: LatLng, to: LatLng, mode: 'train' | 'metro') => Promise<boolean>,
): Promise<ModeAvailability[]> {
  const transit = async (mode: 'train' | 'metro'): Promise<ModeAvailability> => {
    const [board, alight] = await Promise.all([find(origin, mode), find(destination, mode)]);
    const first = judgeStations(mode, board, alight);
    if ('mode' in first) return first;
    return judgeRide(mode, first, await ride(first.board, first.alight, mode));
  };
  const [train, metro] = await Promise.all([transit('train'), transit('metro')]);
  return [
    { mode: 'walk', status: 'available' },
    { mode: 'bike', status: 'available' },
    { mode: 'car', status: 'available' },
    train,
    metro,
  ];
}
