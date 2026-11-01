import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { MemoryDb } from '../src/db/memoryDb.js';
import { sweep } from '../src/jobs/sweep.js';
import { noPlaces } from '../src/lib/places.js';

const cfg = {
  CORS_ORIGINS: '',
  WATCH_BASE_URL: 'https://arrivo.test/w',
  ENABLE_DEV_ROUTES: 'true' as const,
  DB_DRIVER: 'memory' as const,
  CRON_SECRET: 'a-long-test-cron-secret',
};
const C = { Authorization: 'Bearer dev:carol' };
const B = { Authorization: 'Bearer dev:bob' };
const MIN = 60_000;

let db: MemoryDb;
let api: ReturnType<typeof request>;

beforeEach(() => {
  db = new MemoryDb();
  api = request(createApp(db, cfg));
});

/** Carol travels with Bob (who has the app) as her contact. */
async function start(extra: object = {}) {
  const made = await api.post('/v1/contacts').set(C).send({ name: 'Bob', email: 'bob@example.test' });
  await api.post(`/v1/invitations/${made.body.inviteCode}/accept`).set(B);
  const j = await api
    .post('/v1/journeys')
    .set(C)
    .send({
      destinationName: 'Home',
      expectedArrival: new Date(Date.now() + 120 * MIN).toISOString(),
      contactIds: [made.body.id],
      ...extra,
    });
  expect(j.status).toBe(201);
  return j.body as { id: string; trackToken: string };
}

const bobGot = (type: string) => db.notifications.filter((n) => n.userId === 'dev-bob' && n.type === type);
const at = (minutesFromNow: number) => Date.now() + minutesFromNow * MIN;

describe('5-minute sweep (FR-TRK-22)', () => {
  it('tells contacts and the traveller once when the location stops', async () => {
    const j = await start();
    await db.addLocationPoints(j.id, [{ lat: 30.7, lng: 76.7, recordedAt: new Date().toISOString() }]);

    expect((await sweep(db, noPlaces, at(5))).staleAlerts).toBe(0); // only 5 min quiet
    expect((await sweep(db, noPlaces, at(12))).staleAlerts).toBe(1);
    const alert = bobGot('location_stale');
    expect(alert).toHaveLength(1);
    expect(alert[0]?.title).toMatch(/has not updated for 12 min/);
    expect(JSON.stringify(alert[0])).not.toContain('30.7'); // never coordinates
    expect(db.notifications.some((n) => n.userId === 'dev-carol' && n.type === 'location_stale')).toBe(true);

    // Same quiet spell: not again.
    expect((await sweep(db, noPlaces, at(20))).staleAlerts).toBe(0);
    // The phone comes back, then goes quiet again: a new alert.
    await db.addLocationPoints(j.id, [{ lat: 30.71, lng: 76.71, recordedAt: new Date(at(21)).toISOString() }]);
    expect((await sweep(db, noPlaces, at(25))).staleAlerts).toBe(0);
    expect((await sweep(db, noPlaces, at(33))).staleAlerts).toBe(1);
  });

  it('a paused share is expected silence', async () => {
    const j = await start();
    const r = await api.post(`/v1/track/${j.trackToken}/sharing`).send({ paused: true });
    expect(r.status).toBe(200);
    expect((await sweep(db, noPlaces, at(30))).staleAlerts).toBe(0);
    await api.post(`/v1/track/${j.trackToken}/sharing`).send({ paused: false });
    expect((await sweep(db, noPlaces, at(30))).staleAlerts).toBe(1);
  });

  it('sends a due progress update from a recent location', async () => {
    const j = await start({ updateIntervalMinutes: 15 });
    await db.addLocationPoints(j.id, [{ lat: 30.7, lng: 76.7, recordedAt: new Date(at(15)).toISOString() }]);
    await sweep(db, noPlaces, at(16));
    expect(bobGot('journey_progress')).toHaveLength(1);
  });

  it('marks overdue journeys', async () => {
    await start({ expectedArrival: new Date(Date.now() + MIN).toISOString(), graceMinutes: 1 });
    expect((await sweep(db, noPlaces, at(10))).overdue).toBe(1);
  });

  it('the scheduler route needs the secret', async () => {
    expect((await api.post('/v1/internal/sweep')).status).toBe(401);
    const ok = await api.post('/v1/internal/sweep').set('Authorization', `Bearer ${cfg.CRON_SECRET}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('checked');
  });
});
