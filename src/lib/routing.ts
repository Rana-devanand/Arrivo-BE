import { decodePolyline, encodePolyline, haversine, type LatLng } from './polyline.js';

export type PlanMode = 'walk' | 'bike' | 'car' | 'train' | 'metro';
export type StepKind = 'walk' | 'bike' | 'drive' | 'train' | 'metro' | 'bus' | 'tram';

export interface RouteStep {
  kind: StepKind;
  /** Plain words, e.g. "Walk to Shivajinagar Station" or "Metro Purple Line, 8 stops". */
  label: string;
  distanceMeters: number;
  durationSeconds: number;
  /** Encoded polyline for this leg of the trip. */
  polyline: string;
  from?: string;
  to?: string;
  /** In a train or metro trip: getting to the station, the ride, and getting from the station. */
  role?: 'access' | 'main' | 'egress';
}

export interface RoutePlan {
  mode: PlanMode;
  distanceMeters: number;
  durationSeconds: number;
  /** The whole trip as one encoded polyline. */
  polyline: string;
  steps: RouteStep[];
  /** True when this is a straight-line estimate, not a real route. */
  estimated: boolean;
  /** True when this way of travelling does not work for this trip (for example no train line nearby). */
  unavailable?: boolean;
  note?: string;
}

/** A railway or metro station near a place. */
export interface Station {
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** Straight-line distance from the place we searched around. */
  distanceMeters: number;
  placeId?: string;
}

export type FirstLastMode = 'walk' | 'bike' | 'car';

/** For a train or metro trip: which stations, and how to get to and from them. */
export interface ViaStations {
  board: Pick<Station, 'name' | 'lat' | 'lng'>;
  alight: Pick<Station, 'name' | 'lat' | 'lng'>;
  access: FirstLastMode;
  egress: FirstLastMode;
}

export interface PlanRequest {
  origin: LatLng;
  destination: LatLng;
  mode: PlanMode;
  via?: ViaStations;
}

export interface RoutingProvider {
  readonly enabled: boolean;
  plan(req: PlanRequest): Promise<RoutePlan>;
  /** Nearest stations to a place, closest first. */
  stations(near: LatLng, mode: 'train' | 'metro'): Promise<Station[]>;
}

// Typical average speeds on Indian roads and rails, door to door (km/h).
const SPEED_KMH: Record<PlanMode, number> = { walk: 4.8, bike: 24, car: 26, train: 38, metro: 30 };
// Real routes are longer than the straight line.
const DETOUR: Record<PlanMode, number> = { walk: 1.25, bike: 1.35, car: 1.4, train: 1.2, metro: 1.2 };

/** Straight-line estimate, used when no routing service can answer. */
export function estimatePlan(req: PlanRequest, note?: string, unavailable = false): RoutePlan {
  const straight = haversine(req.origin, req.destination);
  const distance = Math.round(straight * DETOUR[req.mode]);
  const speed = (SPEED_KMH[req.mode] * 1000) / 3600;
  // Trains and metros also cost waiting and walking time at both ends.
  const overhead = req.mode === 'train' ? 20 * 60 : req.mode === 'metro' ? 12 * 60 : 0;
  const duration = Math.round(distance / speed + overhead);
  const kind: StepKind = req.mode === 'car' ? 'drive' : req.mode;
  const polyline = encodePolyline([req.origin, req.destination]);
  return {
    mode: req.mode,
    distanceMeters: distance,
    durationSeconds: duration,
    polyline,
    steps: [
      {
        kind,
        label: kind === 'drive' ? 'Drive to destination' : `${kind[0]!.toUpperCase()}${kind.slice(1)} to destination`,
        distanceMeters: distance,
        durationSeconds: duration,
        polyline,
      },
    ],
    estimated: true,
    ...(unavailable ? { unavailable: true } : {}),
    note: note ?? 'Estimated from the straight-line distance.',
  };
}

/** Rough rail leg between two stations when no timetable service can answer. */
export function estimateRail(from: LatLng, to: LatLng, mode: 'train' | 'metro'): RoutePlan {
  const base = estimatePlan({ origin: from, destination: to, mode });
  const speed = mode === 'train' ? 45 : 32; // km/h on the line itself
  const distance = Math.round(haversine(from, to) * 1.15);
  const duration = Math.round(distance / ((speed * 1000) / 3600) + (mode === 'train' ? 10 : 6) * 60);
  const polyline = encodePolyline([from, to]);
  return {
    ...base,
    distanceMeters: distance,
    durationSeconds: duration,
    polyline,
    steps: [{ kind: mode, label: mode === 'train' ? 'Train' : 'Metro', distanceMeters: distance, durationSeconds: duration, polyline }],
    estimated: true,
    note: 'The train time is an estimate. Check the timetable before you leave.',
  };
}

/**
 * Door-to-door trip by train or metro: get to the boarding station (walk, bike or
 * car), ride to the other station, then get from there to the destination. The
 * three legs are separate steps so the app can colour them differently.
 */
export async function planViaStations(
  req: PlanRequest,
  roads: (r: PlanRequest) => Promise<RoutePlan>,
  rail: (from: LatLng, to: LatLng, mode: 'train' | 'metro') => Promise<RoutePlan | null>,
): Promise<RoutePlan> {
  const via = req.via!;
  const mode = req.mode as 'train' | 'metro';
  const word = mode === 'train' ? 'Train' : 'Metro';
  if (haversine(via.board, via.alight) < 300) {
    return estimatePlan(req, 'The two stations are the same. Pick a different station near your destination.', true);
  }
  const [toStation, ride, fromStation] = await Promise.all([
    roads({ origin: req.origin, destination: via.board, mode: via.access }),
    rail(via.board, via.alight, mode),
    roads({ origin: via.alight, destination: req.destination, mode: via.egress }),
  ]);
  const railLeg = ride ?? estimateRail(via.board, via.alight, mode);
  const verb = (m: FirstLastMode) => (m === 'walk' ? 'Walk' : m === 'bike' ? 'Ride' : 'Drive');
  const kindOf = (m: FirstLastMode): StepKind => (m === 'car' ? 'drive' : m);

  const steps: RouteStep[] = [
    {
      kind: kindOf(via.access),
      label: `${verb(via.access)} to ${via.board.name}`,
      distanceMeters: toStation.distanceMeters,
      durationSeconds: toStation.durationSeconds,
      polyline: toStation.polyline,
      to: via.board.name,
      role: 'access',
    },
    {
      kind: mode,
      label: `${word}: ${via.board.name} to ${via.alight.name}`,
      distanceMeters: railLeg.distanceMeters,
      durationSeconds: railLeg.durationSeconds,
      polyline: railLeg.polyline,
      from: via.board.name,
      to: via.alight.name,
      role: 'main',
    },
    {
      kind: kindOf(via.egress),
      label: `${verb(via.egress)} from ${via.alight.name} to destination`,
      distanceMeters: fromStation.distanceMeters,
      durationSeconds: fromStation.durationSeconds,
      polyline: fromStation.polyline,
      from: via.alight.name,
      role: 'egress',
    },
  ];
  const points = steps.flatMap((s) => decodePolyline(s.polyline));
  const estimated = toStation.estimated || railLeg.estimated || fromStation.estimated;
  const notes = [toStation, railLeg, fromStation].filter((l) => l.estimated && l.note).map((l) => l.note!);
  return {
    mode,
    distanceMeters: steps.reduce((s, x) => s + x.distanceMeters, 0),
    // Waiting for the train is part of the real trip.
    durationSeconds: steps.reduce((s, x) => s + x.durationSeconds, 0) + (railLeg.estimated ? 0 : (mode === 'train' ? 10 : 6) * 60),
    polyline: encodePolyline(points),
    steps,
    estimated,
    ...(estimated ? { note: [...new Set(notes)].join(' ') } : {}),
  };
}

/** Small time-boxed cache, so repeated taps do not repeat paid lookups. */
function ttl<T>(ms: number) {
  const m = new Map<string, { at: number; v: T }>();
  return {
    get(k: string): T | undefined {
      const h = m.get(k);
      if (!h) return undefined;
      if (Date.now() - h.at > ms) {
        m.delete(k);
        return undefined;
      }
      return h.v;
    },
    set(k: string, v: T) {
      m.set(k, { at: Date.now(), v });
      if (m.size > 300) m.delete(m.keys().next().value as string);
    },
  };
}

export const noRouting: RoutingProvider = {
  enabled: false,
  plan: async (req) => {
    if (req.via && (req.mode === 'train' || req.mode === 'metro')) {
      return planViaStations(
        req,
        async (r) => estimatePlan(r),
        async () => null,
      );
    }
    return estimatePlan(req, 'Route service is not set up yet, so this is an estimate.');
  },
  stations: async () => [],
};

const seconds = (d: unknown): number => {
  const n = typeof d === 'string' ? parseInt(d, 10) : Number(d);
  return Number.isFinite(n) ? n : 0;
};

function vehicleKind(type: string | undefined): StepKind {
  switch (type) {
    case 'SUBWAY':
    case 'METRO_RAIL':
    case 'LIGHT_RAIL':
    case 'MONORAIL':
      return 'metro';
    case 'TRAM':
      return 'tram';
    case 'BUS':
    case 'INTERCITY_BUS':
    case 'TROLLEYBUS':
      return 'bus';
    default:
      return 'train';
  }
}

/**
 * Google Routes API. Walk, two-wheeler and drive use road routing with live
 * traffic; train and metro use public transport, so the plan starts with the
 * walk to the station, then the train, then the walk to the destination.
 */
export function googleRouting(apiKey: string): RoutingProvider {
  const FIELDS = [
    'routes.duration',
    'routes.distanceMeters',
    'routes.polyline.encodedPolyline',
    'routes.legs.steps.travelMode',
    'routes.legs.steps.distanceMeters',
    'routes.legs.steps.staticDuration',
    'routes.legs.steps.polyline.encodedPolyline',
    'routes.legs.steps.transitDetails',
  ].join(',');

  const stationCache = ttl<Station[]>(15 * 60_000);
  const legCache = ttl<RoutePlan>(2 * 60_000);

  async function nearbyStations(near: LatLng, mode: 'train' | 'metro'): Promise<Station[]> {
    const key = `${near.lat.toFixed(3)},${near.lng.toFixed(3)}|${mode}`;
    const hit = stationCache.get(key);
    if (hit) return hit;
    let res: Response;
    try {
      res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
        },
        body: JSON.stringify({
          includedTypes: mode === 'metro' ? ['subway_station', 'light_rail_station'] : ['train_station'],
          maxResultCount: 10,
          rankPreference: 'DISTANCE',
          languageCode: 'en',
          locationRestriction: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: mode === 'metro' ? 25_000 : 50_000 } },
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return [];
    }
    if (!res.ok) {
      console.error(`[routes] station search returned ${res.status}`);
      return [];
    }
    const data = (await res.json()) as { places?: Record<string, any>[] };
    const out: Station[] = (data.places ?? [])
      .filter((p) => p.location)
      .map((p) => ({
        name: (p.displayName?.text ?? 'Station') as string,
        address: (p.formattedAddress ?? '') as string,
        lat: p.location.latitude as number,
        lng: p.location.longitude as number,
        placeId: p.id as string | undefined,
        distanceMeters: Math.round(haversine(near, { lat: p.location.latitude, lng: p.location.longitude })),
      }))
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, 6);
    stationCache.set(key, out);
    return out;
  }

  /** Ride between two stations. Null when no timetable service answers (an estimate is used then). */
  async function railBetween(from: LatLng, to: LatLng, mode: 'train' | 'metro'): Promise<RoutePlan | null> {
    const loc = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    try {
      const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
        },
        body: JSON.stringify({
          origin: loc(from),
          destination: loc(to),
          travelMode: 'TRANSIT',
          polylineEncoding: 'ENCODED_POLYLINE',
          transitPreferences: { allowedTravelModes: mode === 'metro' ? ['SUBWAY', 'LIGHT_RAIL'] : ['TRAIN', 'RAIL'] },
          departureTime: new Date(Date.now() + 60_000).toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const route = ((await res.json()) as { routes?: Record<string, any>[] }).routes?.[0];
      if (!route?.polyline?.encodedPolyline) return null;
      const dist = Number(route.distanceMeters ?? 0);
      const dur = seconds(route.duration);
      return {
        mode,
        distanceMeters: dist,
        durationSeconds: dur,
        polyline: route.polyline.encodedPolyline,
        steps: [{ kind: mode, label: mode === 'train' ? 'Train' : 'Metro', distanceMeters: dist, durationSeconds: dur, polyline: route.polyline.encodedPolyline }],
        estimated: false,
      };
    } catch {
      return null;
    }
  }

  const provider: RoutingProvider = {
    enabled: true,
    stations: nearbyStations,
    async plan(req) {
      if (req.via && (req.mode === 'train' || req.mode === 'metro')) {
        return planViaStations(
          req,
          async (r) => {
            const k = `${r.origin.lat.toFixed(4)},${r.origin.lng.toFixed(4)}>${r.destination.lat.toFixed(4)},${r.destination.lng.toFixed(4)}|${r.mode}`;
            const hit = legCache.get(k);
            if (hit) return hit;
            const p = await provider.plan({ origin: r.origin, destination: r.destination, mode: r.mode });
            legCache.set(k, p);
            return p;
          },
          railBetween,
        );
      }
      const loc = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
      const transit = req.mode === 'train' || req.mode === 'metro';
      const body: Record<string, unknown> = {
        origin: loc(req.origin),
        destination: loc(req.destination),
        travelMode: transit ? 'TRANSIT' : req.mode === 'walk' ? 'WALK' : req.mode === 'bike' ? 'TWO_WHEELER' : 'DRIVE',
        polylineEncoding: 'ENCODED_POLYLINE',
        languageCode: 'en-IN',
        regionCode: 'IN',
        units: 'METRIC',
      };
      if (transit) {
        body.transitPreferences = {
          allowedTravelModes: req.mode === 'metro' ? ['SUBWAY', 'LIGHT_RAIL'] : ['TRAIN', 'RAIL'],
          routingPreference: 'FEWER_TRANSFERS',
        };
        body.departureTime = new Date(Date.now() + 60_000).toISOString();
      } else if (req.mode === 'car' || req.mode === 'bike') {
        body.routingPreference = 'TRAFFIC_AWARE';
      }

      let res: Response;
      try {
        res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELDS },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return estimatePlan(req, 'Could not reach the route service, so this is an estimate.');
      }
      if (!res.ok) {
        console.error(`[routes] Google returned ${res.status}`);
        return estimatePlan(req, 'Route service is not available right now, so this is an estimate.');
      }
      const data = (await res.json()) as { routes?: Record<string, any>[] };
      const route = data.routes?.[0];
      if (!route?.polyline?.encodedPolyline) {
        if (transit) return estimatePlan(req, `There is no ${req.mode} route for this trip.`, true);
        return estimatePlan(req, 'No route was found, so this is an estimate.');
      }

      const rawSteps: Record<string, any>[] = route.legs?.[0]?.steps ?? [];
      let steps: RouteStep[];
      if (transit) {
        steps = [];
        rawSteps.forEach((s, i) => {
          const poly = s.polyline?.encodedPolyline as string | undefined;
          if (!poly) return;
          const dist = Number(s.distanceMeters ?? 0);
          const dur = seconds(s.staticDuration);
          if (s.travelMode === 'TRANSIT' && s.transitDetails) {
            const t = s.transitDetails;
            const kind = vehicleKind(t.transitLine?.vehicle?.type);
            const from = t.stopDetails?.departureStop?.name as string | undefined;
            const to = t.stopDetails?.arrivalStop?.name as string | undefined;
            const line = (t.transitLine?.nameShort ?? t.transitLine?.name ?? '') as string;
            const stops = t.stopCount ? `, ${t.stopCount} stops` : '';
            const word = kind === 'metro' ? 'Metro' : kind === 'bus' ? 'Bus' : kind === 'tram' ? 'Tram' : 'Train';
            steps.push({
              kind,
              label: `${word}${line ? ` ${line}` : ''}${stops}`,
              distanceMeters: dist,
              durationSeconds: dur,
              polyline: poly,
              from,
              to,
            });
          } else {
            // Walks: name the place they lead to.
            const next = rawSteps.slice(i + 1).find((x) => x.travelMode === 'TRANSIT')?.transitDetails;
            const target = next?.stopDetails?.departureStop?.name as string | undefined;
            steps.push({
              kind: 'walk',
              label: target ? `Walk to ${target}` : 'Walk to destination',
              distanceMeters: dist,
              durationSeconds: dur,
              polyline: poly,
              to: target,
            });
          }
        });
        if (!steps.some((s) => s.kind !== 'walk')) {
          return estimatePlan(req, `There is no ${req.mode} route for this trip.`, true);
        }
      } else {
        const kind: StepKind = req.mode === 'car' ? 'drive' : req.mode;
        steps = [
          {
            kind,
            label: kind === 'drive' ? 'Drive to destination' : kind === 'walk' ? 'Walk to destination' : 'Ride to destination',
            distanceMeters: Number(route.distanceMeters ?? 0),
            durationSeconds: seconds(route.duration),
            polyline: route.polyline.encodedPolyline,
          },
        ];
      }
      return {
        mode: req.mode,
        distanceMeters: Number(route.distanceMeters ?? 0),
        durationSeconds: seconds(route.duration),
        polyline: route.polyline.encodedPolyline,
        steps,
        estimated: false,
      };
    },
  };
  return provider;
}
