import { afterEach, describe, expect, it, vi } from 'vitest';

import { clock } from '../src/lib/notify.js';
import { googleRouting } from '../src/lib/routing.js';

const place = (id: string, name: string, lat: number, lng: number) => ({
  id,
  displayName: { text: name },
  formattedAddress: 'India',
  location: { latitude: lat, longitude: lng },
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** The half-width in degrees of a text search rectangle. */
const halfWidth = (body: { locationRestriction: { rectangle: { low: { latitude: number }; high: { latitude: number } } } }) =>
  (body.locationRestriction.rectangle.high.latitude - body.locationRestriction.rectangle.low.latitude) / 2;

describe('station search (FR-JRN station suggestions)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('widens the search step by step in a village with no station nearby', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        calls.push(url);
        if (url.includes('searchNearby')) return json({}); // nothing within 50 km
        // Only the 1 degree box (about 110 km) is wide enough to see stations.
        return json(
          halfWidth(JSON.parse(init.body)) >= 1
            ? { places: [place('b', 'Barkakana Junction', 23.6, 85.5), place('a', 'Ranchi Junction', 23.35, 85.33), place('c', 'Muri', 23.2, 85.9)] }
            : {},
        );
      }),
    );

    const found = await googleRouting('key').stations({ lat: 23.4, lng: 85.4 }, 'train');
    expect(found.map((s) => s.name)).toEqual(['Ranchi Junction', 'Barkakana Junction', 'Muri']); // nearest first
    expect(found[0]!.distanceMeters).toBeGreaterThan(5_000);
    // One nearby search, then the 0.5 and 1 degree boxes, then it stops (3 found).
    expect(calls.filter((u) => u.includes('searchText'))).toHaveLength(2);
  });

  it('does not widen when enough stations are already close', async () => {
    const fetchMock = vi.fn(async () =>
      json({ places: [place('a', 'A', 26.85, 80.95), place('b', 'B', 26.9, 80.9), place('c', 'C', 26.8, 81.0)] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const found = await googleRouting('key').stations({ lat: 26.84, lng: 80.94 }, 'train');
    expect(found).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up with an empty list, and does not remember a failed answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })));
    const routing = googleRouting('key');
    expect(await routing.stations({ lat: 10, lng: 10 }, 'metro')).toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async () => json({ places: [place('m', 'Metro 1', 10.01, 10.01)] })));
    expect((await routing.stations({ lat: 10, lng: 10 }, 'metro')).map((s) => s.name)).toEqual(['Metro 1']);
  });
});

describe('clock text for notifications', () => {
  const now = new Date('2026-10-25T06:00:00Z'); // 11:30 AM in India

  it('is just the time on the same day', () => {
    expect(clock('2026-10-25T12:30:00Z', now)).toMatch(/6:00 PM/i);
    expect(clock('2026-10-25T12:30:00Z', now)).not.toMatch(/Tomorrow|Oct/);
  });

  it('says Tomorrow for the next day, and the date after that', () => {
    expect(clock('2026-10-26T12:30:00Z', now)).toMatch(/^Tomorrow, 6:00 PM/i);
    expect(clock('2026-10-27T14:30:00Z', now)).toMatch(/^Tue,? 27 Oct,? 8:00 PM/i);
  });
});
