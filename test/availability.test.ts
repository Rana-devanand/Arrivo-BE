import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkAvailability, judgeRide, judgeStations, type StationLookup } from '../src/domain/modeAvailability.js';
import { googleRouting, type Station } from '../src/lib/routing.js';

const st = (name: string, lat: number, lng: number, distanceMeters: number, address = 'India'): Station => ({
  name,
  address,
  lat,
  lng,
  distanceMeters,
});
const found = (...stations: Station[]): StationLookup => ({ stations, failed: false });
const failed: StationLookup = { stations: [], failed: true };

// Real places, roughly.
const newDelhi = st('New Delhi', 28.643, 77.222, 2_000);
const patna = st('Patna Junction', 25.603, 85.137, 1_500);
const rajivChowk = st('Rajiv Chowk', 28.633, 77.219, 1_200, 'New Delhi, Delhi, India');
const noida18 = st('Noida Sector 18', 28.57, 77.326, 900, 'Noida, Uttar Pradesh, India');
const csmt = st('CSMT Metro', 18.94, 72.835, 1_000, 'Mumbai, Maharashtra, India');

describe('mode availability (FR-JRN-11)', () => {
  it('an interstate train trip with stations at both ends is never "unavailable"', () => {
    const pair = judgeStations('train', found(newDelhi), found(patna));
    expect('mode' in pair).toBe(false);
    if ('mode' in pair) return;
    // No timetable from the map service: an estimate, not "no train".
    expect(judgeRide('train', pair, false)).toMatchObject({ status: 'estimate' });
    expect(judgeRide('train', pair, true)).toMatchObject({ status: 'available' });
  });

  it('a failed search is an estimate with retry, not "no station"', () => {
    expect(judgeStations('train', failed, found(patna))).toMatchObject({ status: 'estimate', retry: true });
    expect(judgeStations('metro', found(rajivChowk), failed)).toMatchObject({ status: 'estimate', retry: true });
  });

  it('is unavailable when there really is no station', () => {
    expect(judgeStations('train', found(), found(patna))).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('starting point'),
    });
    expect(judgeStations('train', found(newDelhi), found())).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('destination'),
    });
  });

  it('is unavailable when both ends share the one station', () => {
    expect(judgeStations('train', found(newDelhi), found(newDelhi))).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('same train station'),
    });
  });

  it('metro across a state line in one city works (Delhi to Noida)', () => {
    const pair = judgeStations('metro', found(rajivChowk), found(noida18));
    expect('mode' in pair).toBe(false);
  });

  it('metro between two cities is unavailable (Delhi to Mumbai)', () => {
    expect(judgeStations('metro', found(rajivChowk), found(csmt))).toMatchObject({
      status: 'unavailable',
      reason: 'The metro does not connect these two cities.',
    });
  });

  it('metro is unavailable when the nearest station is far from an end', () => {
    const far = { ...noida18, distanceMeters: 40_000 };
    expect(judgeStations('metro', found(rajivChowk), found(far))).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('40 km from your destination'),
    });
  });

  it('a train across a border without a timetable says to check', () => {
    const lahore = st('Lahore Junction', 31.58, 74.33, 1_000, 'Lahore, Pakistan');
    const amritsar = st('Amritsar Junction', 31.63, 74.87, 1_000, 'Amritsar, Punjab, India');
    const pair = judgeStations('train', found(amritsar), found(lahore));
    if ('mode' in pair) throw new Error('expected stations');
    expect(judgeRide('train', pair, false).reason).toMatch(/crosses a border/);
  });

  it('checks every mode at once; road modes are always offered', async () => {
    const modes = await checkAvailability(
      { lat: 28.63, lng: 77.22 },
      { lat: 25.6, lng: 85.13 },
      async (near, mode) => (mode === 'metro' ? found(near.lat > 27 ? rajivChowk : { ...csmt, distanceMeters: 500 }) : found(near.lat > 27 ? newDelhi : patna)),
      async () => false,
    );
    expect(Object.fromEntries(modes.map((m) => [m.mode, m.status]))).toEqual({
      walk: 'available',
      bike: 'available',
      car: 'available',
      train: 'estimate',
      metro: 'unavailable',
    });
  });
});

describe('station search failures', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports a failed search instead of an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota', { status: 429 })));
    const r = await googleRouting('key').findStations({ lat: 23.4, lng: 85.4 }, 'train');
    expect(r).toEqual({ stations: [], failed: true });
  });

  it('a search that ran and found nothing is real proof', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    const r = await googleRouting('key').findStations({ lat: 64.1, lng: -21.9 }, 'train'); // Reykjavik
    expect(r).toEqual({ stations: [], failed: false });
  });
});
