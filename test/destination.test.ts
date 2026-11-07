import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { MemoryDb } from '../src/db/memoryDb.js';
import { clearMemoryCache } from '../src/lib/cache.js';
import { fallbackLanguageFor, LANGUAGE_LABELS, localLanguageFor } from '../src/domain/localLanguage.js';
import { AppError } from '../src/lib/errors.js';
import { cellOf, type NearbyServices, type NearbyServicesProvider } from '../src/lib/nearbyServices.js';
import {
  clip,
  pickHistory,
  rankPlaces,
  splitSections,
  wikipedia,
  type Candidate,
  type DestinationInfo,
  type WikiProvider,
} from '../src/lib/wiki.js';

const cfg = {
  CORS_ORIGINS: '',
  WATCH_BASE_URL: 'https://arrivo.test/w',
  ENABLE_DEV_ROUTES: 'false' as const,
  DB_DRIVER: 'memory' as const,
};
const A = { Authorization: 'Bearer dev:alice' };

const info = (title = 'Amritsar'): DestinationInfo => ({
  title,
  summary: 'A city in Punjab.',
  history: 'Founded in 1574.',
  facts: { country: 'India' },
  places: [{ title: 'Golden Temple', km: 0.4 }],
});

function fakeWiki(over: Partial<WikiProvider> = {}) {
  const calls = { destination: 0, place: 0, photos: 0 };
  const wiki: WikiProvider = {
    enabled: true,
    destination: async () => {
      calls.destination++;
      return { value: info(), complete: true };
    },
    place: async (title) => {
      calls.place++;
      return { value: { title, extract: 'A place.' }, complete: true };
    },
    photos: async () => {
      calls.photos++;
      return { value: [], complete: true };
    },
    ...over,
  };
  return { wiki, calls };
}

const services = (): NearbyServices => ({
  police: [{ id: 'p1', name: 'City Police Station', address: 'x', lat: 31.62, lng: 74.87 }],
  hospitals: [{ id: 'h1', name: 'Civil Hospital', address: 'y', lat: 31.63, lng: 74.88, phone: '0183 000000' }],
  center: { lat: 31.62, lng: 74.87 },
  fetchedAt: new Date().toISOString(),
});

function fakeNearby(over: Partial<NearbyServicesProvider> = {}) {
  const calls = { find: 0 };
  const nearby: NearbyServicesProvider = {
    enabled: true,
    find: async () => {
      calls.find++;
      return { value: services(), complete: true };
    },
    ...over,
  };
  return { nearby, calls };
}

function appWith(wiki: WikiProvider, nearby: NearbyServicesProvider, db = new MemoryDb()) {
  return request(createApp(db, cfg, undefined, undefined, undefined, undefined, null, undefined, { wiki, nearby }));
}

const q = { lat: 31.62, lng: 74.8765, name: 'Golden Temple', city: 'Amritsar' };

beforeEach(() => clearMemoryCache());

describe('destination text helpers', () => {
  it('clip stops at the end of a sentence, never mid-word', () => {
    const text = 'First sentence is here. Second sentence is also here. Third sentence is long enough to be cut off somewhere.';
    const out = clip(text, 60);
    expect(out.endsWith('.')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(clip('short', 60)).toBe('short');
  });

  it('splits an article into its lead and top-level sections, sub-headings kept inside', () => {
    const { lead, sections } = splitSections(
      'Lead text.\n\n\n== History ==\nOld times.\n\n=== Foundation ===\nFounded in 1574.\n\n== Geography ==\nOn a plain.\n\n== See also ==\n',
    );
    expect(lead).toBe('Lead text.');
    expect(sections.History).toContain('Old times.');
    expect(sections.History).toContain('Foundation:');
    expect(sections.History).toContain('Founded in 1574.');
    expect(sections.Geography).toBe('On a plain.');
    expect(sections['See also']).toBeUndefined(); // empty sections are dropped
  });

  it('picks History, else an origin or etymology section, else nothing', () => {
    expect(pickHistory({ Geography: 'g', History: 'h' })).toBe('h');
    expect(pickHistory({ Etymology: 'e', Geography: 'g' })).toBe('e');
    expect(pickHistory({ Geography: 'g' })).toBeUndefined();
  });
});

describe('local language', () => {
  it('India is by state, with Hindi for the rest', () => {
    expect(localLanguageFor('India', 'Punjab')).toBe('pa');
    expect(localLanguageFor('India', 'Maharashtra')).toBe('mr');
    expect(localLanguageFor('india', '  TAMIL  nadu ')).toBe('ta');
    expect(localLanguageFor('India', 'Jharkhand')).toBe('hi');
    expect(localLanguageFor('India', undefined)).toBe('hi');
  });

  it('other countries use their own language; English-speaking ones and unknown places get none', () => {
    expect(localLanguageFor('Japan')).toBe('ja');
    expect(localLanguageFor('France', 'Île-de-France')).toBe('fr');
    expect(localLanguageFor('United States', 'New York')).toBeUndefined();
    expect(localLanguageFor('United Kingdom')).toBeUndefined();
    expect(localLanguageFor(undefined, 'Punjab')).toBeUndefined();
    expect(localLanguageFor('Atlantis')).toBeUndefined();
  });

  it('only India has a second try, and it is Hindi', () => {
    expect(fallbackLanguageFor('India', 'pa')).toBe('hi');
    expect(fallbackLanguageFor('India', 'hi')).toBeUndefined();
    expect(fallbackLanguageFor('Japan', 'ja')).toBeUndefined();
  });

  it('every language we can pick has a name to show on the switch', () => {
    for (const code of ['pa', 'hi', 'mr', 'gu', 'ta', 'te', 'kn', 'ml', 'bn', 'or', 'as', 'ur', 'ja', 'fr']) {
      expect(LANGUAGE_LABELS[code], code).toBeTruthy();
    }
  });
});

describe('rankPlaces', () => {
  const origin = { lat: 31.62, lng: 74.8765 };
  const c = (title: string, description: string, thumbnail?: string, d = 0.01): Candidate => ({
    title,
    description,
    thumbnail,
    lat: origin.lat + d,
    lng: origin.lng,
  });

  it('puts sights first and drops events, institutions, towns and the place itself', () => {
    const out = rankPlaces(
      [
        c('Amritsar', 'Metropolis in Punjab, India', 'a.jpg'),
        c('Amritsar train disaster', 'Rail accident in 2018', 'b.jpg'),
        c('Khalsa College, Amritsar', 'College in Amritsar', 'c.jpg'),
        c('Aditya Birla Memorial Hospital', 'Hospital in Pune', 'd.jpg'),
        c('Jallianwala Bagh', 'Public garden in Amritsar', 'e.jpg'),
        c('Durgiana Temple', 'Hindu temple in Amritsar', 'f.jpg', 0.05),
        c('Golden Temple', 'Gurdwara in Amritsar', 'g.jpg'),
      ],
      origin,
      'Golden Temple',
    );
    expect(out.map((p) => p.title)).toEqual(['Jallianwala Bagh', 'Durgiana Temple']);
    expect(out[0]!.km).toBeLessThan(out[1]!.km);
  });

  it('fills a quiet area with photographed non-institution places, at most six', () => {
    const items = Array.from({ length: 10 }, (_, i) => c(`Spot ${i}`, 'Place near Pune', `t${i}.jpg`, i / 100));
    expect(rankPlaces(items, origin, 'X')).toHaveLength(6);
    expect(rankPlaces([c('No photo', 'Place near Pune')], origin, 'X')).toHaveLength(0);
  });
});

describe('destination routes', () => {
  it('needs a sign-in', async () => {
    const { wiki } = fakeWiki();
    const { nearby } = fakeNearby();
    const app = appWith(wiki, nearby);
    expect((await app.get('/v1/destination/info').query(q)).status).toBe(401);
    expect((await app.get('/v1/emergency/nearby').query({ lat: 1, lng: 1 })).status).toBe(401);
  });

  it('is off (503) when the information service is not set up', async () => {
    const app = request(createApp(new MemoryDb(), cfg));
    expect((await app.get('/v1/destination/info').query(q).set(A)).status).toBe(503);
    expect((await app.get('/v1/emergency/nearby').query({ lat: 1, lng: 1 }).set(A)).status).toBe(503);
  });

  it('rejects a bad pin', async () => {
    const { wiki } = fakeWiki();
    const { nearby } = fakeNearby();
    const res = await appWith(wiki, nearby).get('/v1/destination/info').query({ lat: 200, lng: 0, name: 'x' }).set(A);
    expect(res.status).toBe(400);
  });

  it('looks a place up once, then answers from the cache (fast, free)', async () => {
    const { wiki, calls } = fakeWiki();
    const { nearby } = fakeNearby();
    const app = appWith(wiki, nearby);
    const first = await app.get('/v1/destination/info').query(q).set(A);
    expect(first.status).toBe(200);
    expect(first.body.history).toBe('Founded in 1574.');
    // Same place from another phone, a few metres away: still one lookup.
    const second = await app.get('/v1/destination/info').query({ ...q, lat: 31.6204 }).set({ Authorization: 'Bearer dev:bob' });
    expect(second.body.title).toBe('Amritsar');
    expect(calls.destination).toBe(1);
  });

  it('survives a cold server: the shared database cache answers when memory is empty', async () => {
    const db = new MemoryDb();
    const { wiki, calls } = fakeWiki();
    const { nearby } = fakeNearby();
    await appWith(wiki, nearby, db).get('/v1/destination/info').query(q).set(A);
    clearMemoryCache();
    const again = await appWith(wiki, nearby, db).get('/v1/destination/info').query(q).set(A);
    expect(again.status).toBe(200);
    expect(calls.destination).toBe(1);
  });

  it('never stores a partial answer, so a failed part is retried next time', async () => {
    let n = 0;
    const { wiki } = fakeWiki({
      destination: async () => {
        n++;
        return { value: info(), complete: false };
      },
    });
    const { nearby } = fakeNearby();
    const app = appWith(wiki, nearby);
    expect((await app.get('/v1/destination/info').query(q).set(A)).status).toBe(200);
    expect((await app.get('/v1/destination/info').query(q).set(A)).status).toBe(200);
    expect(n).toBe(2);
  });

  it('says 404 when nothing is written about a place, and does not cache that', async () => {
    let n = 0;
    const { wiki } = fakeWiki({
      destination: async () => {
        n++;
        return null;
      },
    });
    const { nearby } = fakeNearby();
    const app = appWith(wiki, nearby);
    expect((await app.get('/v1/destination/info').query(q).set(A)).status).toBe(404);
    expect((await app.get('/v1/destination/info').query(q).set(A)).status).toBe(404);
    expect(n).toBe(2);
  });

  it('place details and photos are cached too', async () => {
    const { wiki, calls } = fakeWiki();
    const { nearby } = fakeNearby();
    const app = appWith(wiki, nearby);
    for (let i = 0; i < 2; i++) {
      expect((await app.get('/v1/destination/place').query({ title: 'Akal Takht' }).set(A)).body.title).toBe('Akal Takht');
      expect((await app.get('/v1/destination/photos').query({ lat: 31.62, lng: 74.87 }).set(A)).body.items).toEqual([]);
    }
    expect(calls.place).toBe(1);
    expect(calls.photos).toBe(1);
  });
});

describe('nearby police stations and hospitals', () => {
  it('searches once per 1 km cell and shares the answer between people', async () => {
    const { wiki } = fakeWiki();
    const { nearby, calls } = fakeNearby();
    const app = appWith(wiki, nearby);
    const a = await app.get('/v1/emergency/nearby').query({ lat: 31.6201, lng: 74.8701 }).set(A);
    expect(a.status).toBe(200);
    expect(a.body.police[0].name).toBe('City Police Station');
    expect(a.body.hospitals[0].phone).toBe('0183 000000');
    await app.get('/v1/emergency/nearby').query({ lat: 31.6249, lng: 74.8749 }).set({ Authorization: 'Bearer dev:bob' });
    expect(calls.find).toBe(1);
    // Another town is another cell.
    await app.get('/v1/emergency/nearby').query({ lat: 28.61, lng: 77.2 }).set(A);
    expect(calls.find).toBe(2);
  });

  it('does not store a half answer', async () => {
    const { wiki } = fakeWiki();
    let n = 0;
    const { nearby } = fakeNearby({
      find: async () => {
        n++;
        return { value: { ...services(), hospitals: [] }, complete: false };
      },
    });
    const app = appWith(wiki, nearby);
    await app.get('/v1/emergency/nearby').query({ lat: 31.62, lng: 74.87 }).set(A);
    await app.get('/v1/emergency/nearby').query({ lat: 31.62, lng: 74.87 }).set(A);
    expect(n).toBe(2);
  });

  it('shows a calm 502 when both searches fail', async () => {
    const { wiki } = fakeWiki();
    const { nearby } = fakeNearby({
      find: async () => {
        throw new AppError(502, 'places_error', 'Could not look up nearby services. Try again in a moment.');
      },
    });
    const res = await appWith(wiki, nearby).get('/v1/emergency/nearby').query({ lat: 1, lng: 1 }).set(A);
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/try again/i);
  });

  it('rounds to a cell so the same area always has the same centre', () => {
    expect(cellOf({ lat: 31.6201, lng: 74.8701 })).toEqual(cellOf({ lat: 31.6249, lng: 74.8749 }));
    expect(cellOf({ lat: 31.6201, lng: 74.8701 })).toEqual({ lat: 31.62, lng: 74.87 });
  });
});

describe('wikipedia provider (stubbed network)', () => {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const page = (title: string, lat: number, lon: number, extra: object = {}) => ({
    title,
    description: 'Gurdwara in Amritsar',
    coordinates: [{ lat, lon }],
    pageprops: { wikibase_item: 'Q1' },
    ...extra,
  });

  function stub(searchPages: object[], extra: (u: URL) => Response | undefined = () => undefined) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = new URL(String(input));
        const custom = extra(u);
        if (custom) return custom;
        const p = u.searchParams;
        if (u.hostname === 'en.wikipedia.org' && p.get('generator') === 'search') return json({ query: { pages: searchPages } });
        if (u.hostname === 'en.wikipedia.org' && p.get('generator') === 'geosearch') {
          return json({
            query: {
              pages: [
                { title: 'Akal Takht', description: 'Sikh seat of authority', coordinates: [{ lat: 31.6205, lon: 74.8766 }], thumbnail: { source: 't.jpg' } },
                { title: 'Amritsar train disaster', description: 'Rail accident in 2018', coordinates: [{ lat: 31.63, lon: 74.88 }] },
              ],
            },
          });
        }
        if (u.hostname === 'en.wikipedia.org' && p.get('prop') === 'extracts|info') {
          return json({
            query: { pages: [{ extract: 'The Golden Temple is a gurdwara.\n\n\n== History ==\nBuilt in 1604.', fullurl: 'https://en.wikipedia.org/wiki/Golden_Temple' }] },
          });
        }
        if (u.hostname === 'www.wikidata.org') return json({ entities: { Q1: { claims: {} } } });
        return new Response('{}', { status: 404 });
      }),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it('builds the story of a place: summary, history and sights, ranked', async () => {
    stub([page('Golden Temple', 31.62, 74.8765)]);
    const got = await wikipedia().destination(q);
    expect(got?.complete).toBe(true);
    expect(got?.value.title).toBe('Golden Temple');
    expect(got?.value.history).toBe('Built in 1604.');
    expect(got?.value.places.map((p) => p.title)).toEqual(['Akal Takht']);
  });

  it('ignores an article that is really about a place far away', async () => {
    // Same name, other end of the country (Delhi, about 400 km away).
    stub([page('Golden Temple', 28.61, 77.2)]);
    const got = await wikipedia().destination(q);
    expect(got?.value.title).not.toBe('Golden Temple');
    expect(got?.value.summary).toBe('');
    expect(got?.value.places).toHaveLength(1);
  });

  it('retries once when Wikimedia says too fast (429)', async () => {
    let first = true;
    stub([page('Golden Temple', 31.62, 74.8765)], (u) => {
      if (first && u.searchParams.get('generator') === 'search') {
        first = false;
        return json({}, 429, { 'retry-after': '0.01' });
      }
      return undefined;
    });
    const got = await wikipedia().destination(q);
    expect(got?.value.title).toBe('Golden Temple');
    expect(got?.complete).toBe(true);
  });

  it('marks the answer incomplete when a part fails, and still returns the rest', async () => {
    stub([page('Golden Temple', 31.62, 74.8765)], (u) => (u.hostname === 'www.wikidata.org' ? json({}, 500) : undefined));
    const got = await wikipedia().destination(q);
    expect(got?.complete).toBe(false);
    expect(got?.value.title).toBe('Golden Temple');
    expect(got?.value.facts).toEqual({});
  });

  const summary = (lang: string, title: string, extract: string) =>
    json({ title, extract });

  it('offers the article in the language of the state (Punjab: Punjabi)', async () => {
    stub([page('Golden Temple', 31.62, 74.8765, { langlinks: [{ lang: 'pa', title: 'ਹਰਿਮੰਦਰ ਸਾਹਿਬ' }] })], (u) =>
      u.hostname === 'pa.wikipedia.org' ? summary('pa', 'ਹਰਿਮੰਦਰ ਸਾਹਿਬ', 'ਹਰਿਮੰਦਰ ਸਾਹਿਬ ਅੰਮ੍ਰਿਤਸਰ ਵਿੱਚ ਹੈ।') : undefined,
    );
    const got = await wikipedia().destination({ ...q, region: 'Punjab', country: 'India' });
    expect(got?.value.local).toEqual({
      lang: 'pa',
      label: 'ਪੰਜਾਬੀ',
      title: 'ਹਰਿਮੰਦਰ ਸਾਹਿਬ',
      extract: 'ਹਰਿਮੰਦਰ ਸਾਹਿਬ ਅੰਮ੍ਰਿਤਸਰ ਵਿੱਚ ਹੈ।',
    });
  });

  it('in India falls back to Hindi when the state language has no article', async () => {
    stub([page('Golden Temple', 31.62, 74.8765)], (u) => {
      if (u.hostname === 'en.wikipedia.org' && u.searchParams.get('prop') === 'langlinks') {
        return json({ query: { pages: [{ langlinks: [{ lang: 'hi', title: 'हरमंदिर साहिब' }] }] } });
      }
      if (u.hostname === 'hi.wikipedia.org') return summary('hi', 'हरमंदिर साहिब', 'हरमंदिर साहिब अमृतसर में है।');
      return undefined;
    });
    const got = await wikipedia().destination({ ...q, region: 'Punjab', country: 'India' });
    expect(got?.value.local?.lang).toBe('hi');
    expect(got?.value.local?.label).toBe('हिन्दी');
  });

  it('does not ask for a second language where English is spoken', async () => {
    const seen: string[] = [];
    stub([page('Golden Temple', 31.62, 74.8765)], (u) => {
      seen.push(u.searchParams.get('prop') ?? '');
      return undefined;
    });
    const got = await wikipedia().destination({ ...q, region: 'New York', country: 'United States' });
    expect(got?.value.local).toBeUndefined();
    expect(seen.some((p) => p.includes('langlinks'))).toBe(false);
  });

  it('a missing local article just means no switch, not an error', async () => {
    stub([page('Golden Temple', 31.62, 74.8765, { langlinks: [{ lang: 'ja', title: 'x' }] })], (u) =>
      u.hostname === 'ja.wikipedia.org' ? new Response('{}', { status: 404 }) : undefined,
    );
    const got = await wikipedia().destination({ ...q, region: 'Tokyo', country: 'Japan' });
    expect(got?.complete).toBe(true);
    expect(got?.value.local).toBeUndefined();
  });

  it('is an error, not "nothing written", when every search failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)));
    await expect(wikipedia().destination(q)).rejects.toMatchObject({ status: 502 });
  });
});
