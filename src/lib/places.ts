import { AppError } from './errors.js';

export interface PlaceSuggestion {
  placeId: string;
  /** Short name, e.g. "Hinjewadi Phase 1". */
  name: string;
  /** Rest of the address, e.g. "Pune, Maharashtra, India". */
  address: string;
  distanceMeters: number | null;
}

export interface PlaceDetails {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export interface SearchOptions {
  query: string;
  sessionToken?: string;
  /** Where the user is. Results near here are ranked first. */
  near?: { lat: number; lng: number };
  language: 'en' | 'hi';
}

export interface PlacesProvider {
  readonly enabled: boolean;
  search(opts: SearchOptions): Promise<PlaceSuggestion[]>;
  details(placeId: string, sessionToken?: string, language?: 'en' | 'hi'): Promise<PlaceDetails>;
  /** Pin drop / current location: turns coordinates into an address. */
  reverse(lat: number, lng: number, language?: 'en' | 'hi'): Promise<PlaceDetails>;
}

const unavailable = () =>
  new AppError(503, 'places_unavailable', 'Place search is not set up on the server yet. You can still use your saved places.');

/** Used when no Google key is configured. */
export const noPlaces: PlacesProvider = {
  enabled: false,
  search: async () => {
    throw unavailable();
  },
  details: async () => {
    throw unavailable();
  },
  reverse: async () => {
    throw unavailable();
  },
};

/** Small time-boxed cache so typing the same thing twice costs nothing. */
class Ttl<T> {
  private map = new Map<string, { at: number; v: T }>();
  constructor(
    private ttlMs: number,
    private max = 500,
  ) {}
  get(k: string): T | undefined {
    const h = this.map.get(k);
    if (!h) return undefined;
    if (Date.now() - h.at > this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    return h.v;
  }
  set(k: string, v: T) {
    this.map.set(k, { at: Date.now(), v });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

/**
 * Google Places API (New) + Geocoding API, called from the server so the key is
 * never inside the app. India first: village and small town names are ranked
 * with the user's location when we have it.
 */
export function googlePlaces(apiKey: string): PlacesProvider {
  const searchCache = new Ttl<PlaceSuggestion[]>(60_000);
  const reverseCache = new Ttl<PlaceDetails>(10 * 60_000);

  async function call(url: string, init: RequestInit & { headers?: Record<string, string> }): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    } catch {
      throw new AppError(502, 'places_unreachable', 'Could not reach the place search service. Try again.');
    }
    if (!res.ok) {
      console.error(`[places] Google returned ${res.status}`);
      throw new AppError(502, 'places_error', 'Place search is having a problem. Try again in a moment.');
    }
    return res.json();
  }

  const headers = (extra: Record<string, string> = {}) => ({
    'content-type': 'application/json',
    'X-Goog-Api-Key': apiKey,
    ...extra,
  });

  return {
    enabled: true,

    async search({ query, sessionToken, near, language }) {
      const key = `${query.toLowerCase()}|${language}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ''}`;
      const hit = searchCache.get(key);
      if (hit) return hit;
      const body: Record<string, unknown> = {
        input: query,
        includedRegionCodes: ['in'],
        languageCode: language,
        regionCode: 'IN',
      };
      if (sessionToken) body.sessionToken = sessionToken;
      if (near) {
        body.locationBias = { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50_000 } };
        body.origin = { latitude: near.lat, longitude: near.lng };
      }
      const data = (await call('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      })) as { suggestions?: { placePrediction?: Record<string, any> }[] };
      const out: PlaceSuggestion[] = [];
      for (const s of data.suggestions ?? []) {
        const p = s.placePrediction;
        if (!p?.placeId) continue;
        out.push({
          placeId: p.placeId,
          name: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
          address: p.structuredFormat?.secondaryText?.text ?? '',
          distanceMeters: typeof p.distanceMeters === 'number' ? p.distanceMeters : null,
        });
      }
      searchCache.set(key, out);
      return out;
    },

    async details(placeId, sessionToken, language = 'en') {
      const qs = new URLSearchParams({ languageCode: language, regionCode: 'IN' });
      if (sessionToken) qs.set('sessionToken', sessionToken);
      const p = (await call(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?${qs}`, {
        method: 'GET',
        headers: headers({ 'X-Goog-FieldMask': 'id,displayName,formattedAddress,location' }),
      })) as Record<string, any>;
      if (!p.location) throw new AppError(404, 'not_found', 'That place has no location.');
      return {
        placeId: p.id ?? placeId,
        name: p.displayName?.text ?? '',
        address: p.formattedAddress ?? '',
        lat: p.location.latitude,
        lng: p.location.longitude,
      };
    },

    async reverse(lat, lng, language = 'en') {
      const key = `${lat.toFixed(4)},${lng.toFixed(4)}|${language}`;
      const hit = reverseCache.get(key);
      if (hit) return hit;
      const qs = new URLSearchParams({ latlng: `${lat},${lng}`, language, key: apiKey });
      const data = (await call(`https://maps.googleapis.com/maps/api/geocode/json?${qs}`, { method: 'GET', headers: {} })) as {
        status?: string;
        results?: { formatted_address: string; address_components: { long_name: string; types: string[] }[]; place_id: string }[];
      };
      if (data.status === 'ZERO_RESULTS' || !data.results?.length) {
        const out = { placeId: '', name: 'Dropped pin', address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, lat, lng };
        reverseCache.set(key, out);
        return out;
      }
      if (data.status !== 'OK') {
        console.error(`[places] geocoding status ${data.status}`);
        throw new AppError(502, 'places_error', 'Could not read this location. Try again in a moment.');
      }
      const r = data.results[0]!;
      const pick = (...types: string[]) => r.address_components.find((c) => types.some((t) => c.types.includes(t)))?.long_name;
      // Villages show up as "sublocality" or "locality"; fall back to the first part of the address.
      const name =
        pick('point_of_interest', 'premise', 'sublocality_level_1', 'sublocality', 'locality', 'administrative_area_level_3') ??
        r.formatted_address.split(',')[0]!.trim();
      const out = { placeId: r.place_id, name, address: r.formatted_address, lat, lng };
      reverseCache.set(key, out);
      return out;
    },
  };
}
