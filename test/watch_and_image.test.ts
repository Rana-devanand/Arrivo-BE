import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { DEV_SITE_URL, PROD_SITE_URL, siteOrigins, watchBaseUrl } from '../src/config.js';
import { MemoryDb } from '../src/db/memoryDb.js';
import { isWikimediaImage } from '../src/routes/journeys.js';

const base = { CORS_ORIGINS: '', ENABLE_DEV_ROUTES: 'true' as const, DB_DRIVER: 'memory' as const };
const A = { Authorization: 'Bearer dev:alice' };
const B = { Authorization: 'Bearer dev:bob' };

describe('where watch links point (dev on localhost, production from the environment)', () => {
  it('uses the local website on a developer machine, whatever SITE_URL says', () => {
    expect(watchBaseUrl({ NODE_ENV: 'development' })).toBe(`${DEV_SITE_URL}/watch`);
    expect(watchBaseUrl({ NODE_ENV: 'development', SITE_URL: 'https://tryarrivo.com' })).toBe(`${DEV_SITE_URL}/watch`);
    expect(watchBaseUrl({ NODE_ENV: 'test' })).toBe(`${DEV_SITE_URL}/watch`);
    expect(watchBaseUrl({})).toBe(`${DEV_SITE_URL}/watch`);
  });

  it('uses the live website from SITE_URL in production', () => {
    expect(watchBaseUrl({ NODE_ENV: 'production', SITE_URL: 'https://tryarrivo.com' })).toBe('https://tryarrivo.com/watch');
    expect(watchBaseUrl({ NODE_ENV: 'production', SITE_URL: 'https://tryarrivo.com/' })).toBe('https://tryarrivo.com/watch');
    expect(watchBaseUrl({ NODE_ENV: 'production' })).toBe(`${PROD_SITE_URL}/watch`);
  });

  it('an explicit WATCH_BASE_URL always wins, without a trailing slash', () => {
    expect(watchBaseUrl({ NODE_ENV: 'production', WATCH_BASE_URL: 'https://x.test/w/' })).toBe('https://x.test/w');
    expect(watchBaseUrl({ NODE_ENV: 'development', WATCH_BASE_URL: 'https://x.test/w' })).toBe('https://x.test/w');
    expect(watchBaseUrl({ WATCH_BASE_URL: '   ' })).toBe(`${DEV_SITE_URL}/watch`); // blank means unset
  });

  it('allows the local website in development and only the live one (with and without www) in production', () => {
    expect(siteOrigins({ NODE_ENV: 'development' })).toEqual([DEV_SITE_URL, 'http://127.0.0.1:3000']);
    expect(siteOrigins({ NODE_ENV: 'production', SITE_URL: 'https://tryarrivo.com' })).toEqual([
      'https://tryarrivo.com',
      'https://www.tryarrivo.com',
    ]);
    expect(siteOrigins({ NODE_ENV: 'production', SITE_URL: 'https://www.tryarrivo.com' })).toEqual([
      'https://www.tryarrivo.com',
      'https://tryarrivo.com',
    ]);
  });
});

describe('the browser may call the watch API only from the website', () => {
  const preflight = (app: ReturnType<typeof createApp>, origin: string) =>
    request(app).options('/v1/watch/abcdefghijklmnopqrstu').set('Origin', origin).set('Access-Control-Request-Method', 'GET');

  it('development: the local website is allowed, another site is not', async () => {
    const app = createApp(new MemoryDb(), { ...base, NODE_ENV: 'development' });
    expect((await preflight(app, DEV_SITE_URL)).headers['access-control-allow-origin']).toBe(DEV_SITE_URL);
    expect((await preflight(app, 'https://evil.test')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('production: the live website is allowed, the local one is not', async () => {
    const app = createApp(new MemoryDb(), { ...base, NODE_ENV: 'production', SITE_URL: 'https://tryarrivo.com' });
    expect((await preflight(app, 'https://tryarrivo.com')).headers['access-control-allow-origin']).toBe('https://tryarrivo.com');
    expect((await preflight(app, 'https://www.tryarrivo.com')).headers['access-control-allow-origin']).toBe('https://www.tryarrivo.com');
    expect((await preflight(app, DEV_SITE_URL)).headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('watch link and destination picture', () => {
  let db: MemoryDb;
  let api: ReturnType<typeof request>;

  beforeEach(() => {
    db = new MemoryDb();
    api = request(createApp(db, { ...base, NODE_ENV: 'development' }));
  });

  async function contact(headers = A) {
    const created = await api.post('/v1/contacts').set(headers).send({ name: 'Aisha Khan', phone: '+1 202 555 0143' });
    expect(created.status).toBe(201);
    expect((await api.post(`/v1/dev/contacts/${created.body.id}/accept`).set(headers)).status).toBe(200);
    return created.body.id as string;
  }

  const journey = (contactIds: string[], extra: object = {}) => ({
    destinationName: 'Golden Temple',
    destinationLat: 31.62,
    destinationLng: 74.8765,
    expectedArrival: new Date(Date.now() + 30 * 60_000).toISOString(),
    contactIds,
    ...extra,
  });

  it('the link a new journey gets points at the local website in development', async () => {
    const id = await contact();
    const res = await api.post('/v1/journeys').set(A).send(journey([id], { createWatchLink: true }));
    expect(res.status).toBe(201);
    expect(res.body.watch.url).toBe(`${DEV_SITE_URL}/watch#${res.body.watch.token}`);
  });

  it('the public watch page data says when sharing is paused and when the trip started', async () => {
    const id = await contact();
    const made = await api.post('/v1/journeys').set(A).send(journey([id], { createWatchLink: true }));
    const { token } = made.body.watch;

    const live = await api.get(`/v1/watch/${token}`);
    expect(live.status).toBe(200);
    expect(live.body.sharingPaused).toBe(false);
    expect(live.body.startedAt).toBe(made.body.startedAt);
    expect(live.headers['cache-control']).toBe('no-store'); // a live position is never cached

    await api.post(`/v1/track/${made.body.trackToken}/sharing`).send({ paused: true });
    expect((await api.get(`/v1/watch/${token}`)).body.sharingPaused).toBe(true);
  });

  it('keeps a Wikimedia destination picture with the journey and returns it in the history', async () => {
    const id = await contact();
    const picture = 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bc/Golden_Temple_2004.jpg/400px-Golden_Temple_2004.jpg';
    const made = await api.post('/v1/journeys').set(A).send(journey([id], { destinationImageUrl: picture }));
    expect(made.status).toBe(201);
    expect(made.body.destinationImageUrl).toBe(picture);

    await api.post(`/v1/journeys/${made.body.id}/complete`).set(A);
    const list = await api.get('/v1/journeys').set(A);
    expect(list.body.items[0].destinationImageUrl).toBe(picture);
  });

  it('keeps the destination address with the journey, so its state and country can be read again', async () => {
    const id = await contact();
    const address = 'Golden Temple Rd, Amritsar, Punjab 143006, India';
    const made = await api.post('/v1/journeys').set(A).send(journey([id], { destinationAddress: address }));
    expect(made.status).toBe(201);
    expect(made.body.destinationAddress).toBe(address);
    expect((await api.get('/v1/journeys/active').set(A)).body.destinationAddress).toBe(address);
    // The public watch view never carries it.
    const withLink = await api.get('/v1/watch/short');
    expect(withLink.status).toBe(404);
  });

  it('a journey without an address or picture just has none', async () => {
    const id = await contact();
    const made = await api.post('/v1/journeys').set(A).send(journey([id], { destinationAddress: '' }));
    expect(made.body.destinationAddress).toBeNull();
  });

  it('a journey without a picture just has none', async () => {
    const id = await contact();
    const made = await api.post('/v1/journeys').set(A).send(journey([id]));
    expect(made.body.destinationImageUrl).toBeNull();
  });

  it('drops a picture address that is not from Wikimedia, and the journey still starts', async () => {
    const id = await contact();
    for (const bad of [
      'https://evil.test/a.jpg',
      'http://upload.wikimedia.org/a.jpg',
      'https://wikimedia.org.evil.test/a.jpg',
      'javascript:alert(1)',
      'not a url',
    ]) {
      await api.post(`/v1/journeys/${(await api.get('/v1/journeys/active').set(A)).body?.id ?? 'none'}/cancel`).set(A);
      const res = await api.post('/v1/journeys').set(A).send(journey([id], { destinationImageUrl: bad }));
      expect(res.status, bad).toBe(201);
      expect(res.body.destinationImageUrl, bad).toBeNull();
    }
  });

  it('nobody else can read the picture, or the journey it belongs to', async () => {
    const id = await contact();
    const picture = 'https://upload.wikimedia.org/wikipedia/commons/a/a1/X.jpg';
    const made = await api.post('/v1/journeys').set(A).send(journey([id], { destinationImageUrl: picture }));
    expect((await api.get(`/v1/journeys/${made.body.id}`).set(B)).status).toBe(404);
    expect((await api.get('/v1/journeys').set(B)).body.items).toEqual([]);
  });

  it('isWikimediaImage accepts only https pictures on wikimedia.org', () => {
    expect(isWikimediaImage('https://upload.wikimedia.org/x.jpg')).toBe(true);
    expect(isWikimediaImage('https://thumb.wikimedia.org/x.jpg')).toBe(true);
    expect(isWikimediaImage('https://wikimedia.org/x.jpg')).toBe(true);
    expect(isWikimediaImage('https://notwikimedia.org/x.jpg')).toBe(false);
    expect(isWikimediaImage('http://upload.wikimedia.org/x.jpg')).toBe(false);
  });
});
