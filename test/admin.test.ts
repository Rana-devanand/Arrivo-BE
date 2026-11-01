import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { MemoryDb } from '../src/db/memoryDb.js';

const cfg = {
  CORS_ORIGINS: '',
  WATCH_BASE_URL: 'https://arrivo.test/w',
  ENABLE_DEV_ROUTES: 'true' as const,
  DB_DRIVER: 'memory' as const,
};

const A = { Authorization: 'Bearer dev:alice' };
const B = { Authorization: 'Bearer dev:bob' };

let db: MemoryDb;
let api: ReturnType<typeof request>;

beforeEach(() => {
  db = new MemoryDb();
  api = request(createApp(db, cfg));
});

async function makeAdmin(headers: Record<string, string>) {
  const me = await api.get('/v1/me').set(headers);
  const p = db.profiles.get(me.body.id);
  if (!p) throw new Error('no profile');
  p.role = 'ADMIN';
}

describe('profile country and role', () => {
  it('new users are USER with no country', async () => {
    const me = await api.get('/v1/me').set(A);
    expect(me.body.role).toBe('USER');
    expect(me.body.countryCode).toBeNull();
  });

  it('saves the country code in upper case and rejects bad ones', async () => {
    const ok = await api.put('/v1/me').set(A).send({ countryCode: 'in' });
    expect(ok.status).toBe(200);
    expect(ok.body.countryCode).toBe('IN');
    expect((await api.put('/v1/me').set(A).send({ countryCode: 'India' })).status).toBe(400);
  });

  it('a user cannot make themselves an admin through the profile', async () => {
    const res = await api.put('/v1/me').set(A).send({ role: 'ADMIN', user_role: 'ADMIN' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('USER');
    expect((await api.get('/v1/admin/users').set(A)).status).toBe(403);
  });
});

describe('admin dashboard', () => {
  it('needs a sign-in', async () => {
    expect((await api.get('/v1/admin/users')).status).toBe(401);
  });

  it('a USER cannot list users or read journeys', async () => {
    await api.get('/v1/me').set(A);
    expect((await api.get('/v1/admin/users').set(B)).status).toBe(403);
    expect((await api.get('/v1/admin/users/dev-alice/journeys').set(B)).status).toBe(403);
  });

  it('an ADMIN sees every user with country and journey counts', async () => {
    await makeAdmin(A);
    await api.put('/v1/me').set(B).send({ countryCode: 'KE' });
    const contact = await api.post('/v1/contacts').set(B).send({ name: 'Wanjiru', phone: '+254 712 345678' });
    await api.post(`/v1/dev/contacts/${contact.body.id}/accept`).set(B);
    const started = await api
      .post('/v1/journeys')
      .set(B)
      .send({
        destinationName: 'Westlands',
        expectedArrival: new Date(Date.now() + 30 * 60_000).toISOString(),
        contactIds: [contact.body.id],
      });
    expect(started.status).toBe(201);

    const res = await api.get('/v1/admin/users').set(A);
    expect(res.status).toBe(200);
    const bob = res.body.users.find((u: { id: string }) => u.id === 'dev-bob');
    expect(bob).toMatchObject({ countryCode: 'KE', role: 'USER', email: 'bob@example.test' });
    expect(bob.journeys).toMatchObject({ total: 1, active: 1 });

    const list = await api.get('/v1/admin/users/dev-bob/journeys').set(A);
    expect(list.status).toBe(200);
    expect(list.body.journeys[0]).toMatchObject({ destinationName: 'Westlands', status: 'active', contactCount: 1 });
    // No location or secrets in the admin view.
    for (const key of ['destinationLat', 'destinationLng', 'routePolyline', 'trackToken', 'vehicleImageUrl']) {
      expect(list.body.journeys[0]).not.toHaveProperty(key);
    }
  });

  describe('notifications and journey activity', () => {
    const C = { Authorization: 'Bearer dev:carol' };

    /** Carol travels; Bob is her accepted contact with the app, so he gets notifications. */
    async function carolTravels() {
      await makeAdmin(A);
      const made = await api.post('/v1/contacts').set(C).send({ name: 'Bob', email: 'bob@example.test' });
      expect((await api.post(`/v1/invitations/${made.body.inviteCode}/accept`).set(B)).status).toBe(200);
      const j = await api
        .post('/v1/journeys')
        .set(C)
        .send({
          originName: 'Office',
          destinationName: 'Home',
          expectedArrival: new Date(Date.now() + 30 * 60_000).toISOString(),
          contactIds: [made.body.id],
        });
      expect(j.status).toBe(201);
      await db.createNotification('dev-bob', {
        type: 'journey_progress',
        title: 'carol is on MG Road, Koregaon Park',
        body: 'Heading to Home',
        data: { journeyId: j.body.id, place: 'on MG Road, Koregaon Park' },
      });
      await db.createNotification('dev-bob', {
        type: 'sos',
        title: 'SOS from carol',
        body: 'carol pressed the SOS button',
        data: { journeyId: j.body.id, lat: 18.5, lng: 73.9 },
      });
      return j.body.id as string;
    }

    it('lists who got what, with the place, and never coordinates', async () => {
      await carolTravels();
      const res = await api.get('/v1/admin/notifications').set(A);
      expect(res.status).toBe(200);
      const list = res.body.notifications as Record<string, unknown>[];
      const started = list.find((n) => n.type === 'journey_started');
      expect(started).toMatchObject({
        recipient: { id: 'dev-bob', email: 'bob@example.test' },
        traveller: { id: 'dev-carol' },
        place: 'Office',
      });
      expect(list.find((n) => n.type === 'journey_progress')?.place).toBe('on MG Road, Koregaon Park');
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('18.5');
      expect(text).not.toContain('73.9');
      for (const n of list) expect(n).not.toHaveProperty('data');
    });

    it('counts journeys and notifications per user, with the places', async () => {
      const id = await carolTravels();
      const res = await api.get('/v1/admin/journey-activity').set(A);
      expect(res.status).toBe(200);
      const carol = res.body.users.find((u: { id: string }) => u.id === 'dev-carol');
      expect(carol).toMatchObject({ journeyCount: 1, notificationCount: 3 });
      expect(carol.journeys[0]).toMatchObject({ id, notificationCount: 3, recipientCount: 1 });
      expect(carol.journeys[0].places).toEqual(expect.arrayContaining(['Office', 'on MG Road, Koregaon Park']));
      expect(res.body.users[0].id).toBe('dev-carol'); // most journeys first
    });

    it('a USER cannot read either', async () => {
      await carolTravels();
      expect((await api.get('/v1/admin/notifications').set(B)).status).toBe(403);
      expect((await api.get('/v1/admin/journey-activity').set(C)).status).toBe(403);
    });
  });

  it('unknown user gives 404', async () => {
    await makeAdmin(A);
    expect((await api.get('/v1/admin/users/nobody/journeys').set(A)).status).toBe(404);
  });
});
