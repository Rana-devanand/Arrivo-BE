import { AppError } from './errors.js';
import { googleReason } from './googleError.js';
import { errorText, logError } from './log.js';
import type { LatLng } from './polyline.js';

export interface ServicePlace {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  phone?: string;
}

export interface NearbyServices {
  police: ServicePlace[];
  hospitals: ServicePlace[];
  /** The point the search was run around (rounded), so the app can tell when you have moved away from it. */
  center: LatLng;
  fetchedAt: string;
}

export interface NearbyServicesProvider {
  readonly enabled: boolean;
  /** [complete] is false when only one of the two searches worked: show it, do not store it. */
  find(at: LatLng): Promise<{ value: NearbyServices; complete: boolean }>;
}

export const noNearbyServices: NearbyServicesProvider = {
  enabled: false,
  find: async () => {
    throw new AppError(503, 'places_unavailable', 'Nearby police stations and hospitals are not set up on the server yet.');
  },
};

/** How far out we look. The app keeps this list until the person is about this far from the centre. */
export const SERVICES_RADIUS_M = 40_000;
const PER_TYPE = 10;

/** Rounds to about 1 km. The same cell always gives the same centre, so the cache key is exact. */
export const cellOf = (at: LatLng): LatLng => ({
  lat: Math.round(at.lat * 100) / 100,
  lng: Math.round(at.lng * 100) / 100,
});

/**
 * Police stations and hospitals around a point, from Google Places (New). Two
 * searches, nearest first, with only the fields we show. A phone number is the one
 * extra field; it is what makes the list useful in an emergency.
 */
export function googleNearbyServices(apiKey: string): NearbyServicesProvider {
  async function search(type: 'police' | 'hospital', c: LatLng): Promise<ServicePlace[]> {
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber',
      },
      body: JSON.stringify({
        includedTypes: [type],
        maxResultCount: PER_TYPE,
        rankPreference: 'DISTANCE',
        languageCode: 'en',
        locationRestriction: { circle: { center: { latitude: c.lat, longitude: c.lng }, radius: SERVICES_RADIUS_M } },
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`places ${res.status} ${await googleReason(res)}`);
    const data = (await res.json()) as { places?: Record<string, any>[] };
    return (data.places ?? [])
      .filter((p) => p.location)
      .map((p) => ({
        id: String(p.id),
        name: String(p.displayName?.text ?? ''),
        address: String(p.formattedAddress ?? ''),
        lat: p.location.latitude as number,
        lng: p.location.longitude as number,
        ...(p.nationalPhoneNumber ? { phone: String(p.nationalPhoneNumber) } : {}),
      }));
  }

  return {
    enabled: true,
    async find(at) {
      const center = cellOf(at);
      let failures = 0;
      const run = (type: 'police' | 'hospital') =>
        search(type, center).catch((e) => {
          failures++;
          logError(`[services] ${type} search failed: ${errorText(e)}`);
          return [] as ServicePlace[];
        });
      const [police, hospitals] = await Promise.all([run('police'), run('hospital')]);
      if (failures === 2) throw new AppError(502, 'places_error', 'Could not look up nearby services. Try again in a moment.');
      return {
        value: { police, hospitals, center, fetchedAt: new Date().toISOString() },
        complete: failures === 0,
      };
    },
  };
}
