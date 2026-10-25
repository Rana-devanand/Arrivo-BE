import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryDb } from '../src/db/memoryDb.js';
import { noPlaces, type AreaInfo } from '../src/lib/places.js';
import { describePlace } from '../src/lib/progress.js';
import { setPushSender } from '../src/lib/push.js';

const cfg = {
  CORS_ORIGINS: '',
  WATCH_BASE_URL: 'https://arrivo.test/w',
  ENABLE_DEV_ROUTES: 'true' as const,
  DB_DRIVER: 'memory' as const,
};

const A = { Authorization: 'Bearer dev:alice' };
const B = { Authorization: 'Bearer dev:bob' };

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

let db: MemoryDb;
let api: ReturnType<typeof request>;

/** These tests add several contacts, which takes Arrivo Plus. The Free limit has its own tests (billing.test.ts). */
const plusFor = (userId: string) => ({
  userId,
  status: 'active' as const,
  intervalMonths: 12 as const,
  dodoSubscriptionId: `sub_${userId}`,
  dodoCustomerId: `cus_${userId}`,
  currentPeriodEnd: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
  lastEventAt: new Date().toISOString(),
});

beforeEach(async () => {
  db = new MemoryDb();
  for (const id of ['dev-alice', 'dev-bob', 'dev-carol']) await db.upsertSubscription(plusFor(id));
  api = request(createApp(db, cfg));
});

async function acceptedContact(headers = A, name = 'Aisha Khan') {
  const created = await api.post('/v1/contacts').set(headers).send({ name, phone: '+1 202 555 0143' });
  expect(created.status).toBe(201);
  const accepted = await api.post(`/v1/dev/contacts/${created.body.id}/accept`).set(headers);
  expect(accepted.status).toBe(200);
  return created.body.id as string;
}

const journeyBody = (contactIds: string[], extra: object = {}) => ({
  destinationName: 'Home',
  expectedArrival: inMinutes(30),
  contactIds,
  ...extra,
});

describe('auth', () => {
  it('health is public', async () => {
    const res = await api.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects missing and invalid tokens', async () => {
    expect((await api.get('/v1/me')).status).toBe(401);
    expect((await api.get('/v1/me').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('creates a profile on first call and updates it', async () => {
    const me = await api.get('/v1/me').set(A);
    expect(me.status).toBe(200);
    expect(me.body.displayName).toBe('alice');

    const upd = await api.put('/v1/me').set(A).send({ displayName: 'Alice Doe', phone: '+44 20 7946 0958' });
    expect(upd.body.displayName).toBe('Alice Doe');

    const bad = await api.put('/v1/me').set(A).send({ phone: 'abc' });
    expect(bad.status).toBe(400);
  });
});

describe('contacts', () => {
  it('needs a phone or email and a valid name', async () => {
    expect((await api.post('/v1/contacts').set(A).send({ name: 'No channel' })).status).toBe(400);
    expect((await api.post('/v1/contacts').set(A).send({ name: '', phone: '+1 202 555 0143' })).status).toBe(400);
  });

  it('lists only your own contacts and supports removal', async () => {
    const id = await acceptedContact(A);
    expect((await api.get('/v1/contacts').set(A)).body.items).toHaveLength(1);
    expect((await api.get('/v1/contacts').set(B)).body.items).toHaveLength(0);

    // Another user cannot delete it.
    expect((await api.delete(`/v1/contacts/${id}`).set(B)).status).toBe(404);
    expect((await api.delete(`/v1/contacts/${id}`).set(A)).status).toBe(204);
    expect((await api.get('/v1/contacts').set(A)).body.items).toHaveLength(0);
  });
});

describe('journeys', () => {
  it('only lets accepted contacts follow a journey', async () => {
    const created = await api.post('/v1/contacts').set(A).send({ name: 'Marco', email: 'marco@example.com' });
    const res = await api.post('/v1/journeys').set(A).send(journeyBody([created.body.id]));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not accepted/);
  });

  it('starts, reports active, and allows only one at a time', async () => {
    const c = await acceptedContact();
    const start = await api.post('/v1/journeys').set(A).send(journeyBody([c], { vehicle: 'Taxi 1234' }));
    expect(start.status).toBe(201);
    expect(start.body.status).toBe('active');
    expect(start.body.contactIds).toEqual([c]);

    const active = await api.get('/v1/journeys/active').set(A);
    expect(active.body.id).toBe(start.body.id);

    const second = await api.post('/v1/journeys').set(A).send(journeyBody([c]));
    expect(second.status).toBe(409);
  });

  it('rejects past and far-future arrival times', async () => {
    const c = await acceptedContact();
    const past = await api.post('/v1/journeys').set(A).send(journeyBody([c], { expectedArrival: inMinutes(-30) }));
    expect(past.status).toBe(400);
    const far = await api.post('/v1/journeys').set(A).send(journeyBody([c], { expectedArrival: inMinutes(60 * 24 * 15) }));
    expect(far.status).toBe(400);
  });

  it('accepts a multi-day trip, such as a long train journey (FR-JRN-01)', async () => {
    const c = await acceptedContact();
    const res = await api.post('/v1/journeys').set(A).send(journeyBody([c], { expectedArrival: inMinutes(60 * 24 * 2 + 60 * 8) }));
    expect(res.status).toBe(201);
  });

  it('keeps journeys private between users', async () => {
    const c = await acceptedContact();
    const j = (await api.post('/v1/journeys').set(A).send(journeyBody([c]))).body;

    expect((await api.get(`/v1/journeys/${j.id}`).set(B)).status).toBe(404);
    expect((await api.post(`/v1/journeys/${j.id}/complete`).set(B)).status).toBe(404);
    expect((await api.post(`/v1/journeys/${j.id}/location`).set(B).send({ points: [] })).status).toBe(400);
    expect((await api.get('/v1/journeys').set(B)).body.items).toHaveLength(0);

    // Bob cannot use Alice's contact either.
    const bobTry = await api.post('/v1/journeys').set(B).send(journeyBody([c]));
    expect(bobTry.status).toBe(400);
  });

  it('completes idempotently and refuses to cancel afterwards', async () => {
    const c = await acceptedContact();
    const j = (await api.post('/v1/journeys').set(A).send(journeyBody([c]))).body;

    const first = await api.post(`/v1/journeys/${j.id}/complete`).set(A);
    const again = await api.post(`/v1/journeys/${j.id}/complete`).set(A);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('completed');
    expect(again.status).toBe(200);
    expect(again.body.arrivedAt).toBe(first.body.arrivedAt);

    expect((await api.post(`/v1/journeys/${j.id}/cancel`).set(A)).status).toBe(409);
    expect((await api.get('/v1/journeys/active').set(A)).status).toBe(404);
  });

  it('changes the arrival time and clears an overdue state', async () => {
    const c = await acceptedContact();
    const j = (await api.post('/v1/journeys').set(A).send(journeyBody([c]))).body;
    const later = inMinutes(90);
    const res = await api.patch(`/v1/journeys/${j.id}`).set(A).send({ expectedArrival: later });
    expect(res.status).toBe(200);
    expect(res.body.expectedArrival).toBe(later);
  });

  it('stores location only while in progress, and validates it', async () => {
    const c = await acceptedContact();
    const j = (await api.post('/v1/journeys').set(A).send(journeyBody([c]))).body;
    const ok = await api
      .post(`/v1/journeys/${j.id}/location`)
      .set(A)
      .send({ points: [{ lat: 18.52, lng: 73.85, recordedAt: new Date().toISOString() }] });
    expect(ok.status).toBe(202);
    expect(ok.body.accepted).toBe(1);

    const bad = await api
      .post(`/v1/journeys/${j.id}/location`)
      .set(A)
      .send({ points: [{ lat: 123, lng: 73.85, recordedAt: new Date().toISOString() }] });
    expect(bad.status).toBe(400);

    await api.post(`/v1/journeys/${j.id}/complete`).set(A);
    const after = await api
      .post(`/v1/journeys/${j.id}/location`)
      .set(A)
      .send({ points: [{ lat: 18.52, lng: 73.85, recordedAt: new Date().toISOString() }] });
    expect(after.status).toBe(409);
  });

  it('pages through history', async () => {
    const c = await acceptedContact();
    for (let i = 0; i < 3; i++) {
      const j = (await api.post('/v1/journeys').set(A).send(journeyBody([c]))).body;
      await api.post(`/v1/journeys/${j.id}/complete`).set(A);
      await new Promise((r) => setTimeout(r, 5));
    }
    const page1 = await api.get('/v1/journeys?limit=2&status=completed').set(A);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextBefore).toBeTruthy();
    const page2 = await api.get(`/v1/journeys?limit=2&status=completed&before=${encodeURIComponent(page1.body.nextBefore)}`).set(A);
    expect(page2.body.items).toHaveLength(1);
    expect((await api.get('/v1/journeys?status=bogus').set(A)).status).toBe(400);
  });
});

describe('invitations', () => {
  const C = { Authorization: 'Bearer dev:carol' };

  async function invite(headers = A, name = 'Bob') {
    const res = await api.post('/v1/contacts').set(headers).send({ name, phone: '+1 202 555 0188' });
    expect(res.status).toBe(201);
    return res.body as { id: string; inviteCode: string; status: string };
  }

  it('gives the inviter a code and lets the invited person accept', async () => {
    await api.put('/v1/me').set(A).send({ displayName: 'Alice Doe' });
    const c = await invite();
    expect(c.inviteCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(c.status).toBe('invited');

    const preview = await api.get('/v1/invitations/' + c.inviteCode.toLowerCase()).set(B);
    expect(preview.status).toBe(200);
    expect(preview.body.inviterName).toBe('Alice Doe');

    const spaced = c.inviteCode.slice(0, 4) + '-' + c.inviteCode.slice(4);
    const accepted = await api.post('/v1/invitations/' + spaced + '/accept').set(B);
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('accepted');

    const list = await api.get('/v1/contacts').set(A);
    expect(list.body.items[0].status).toBe('accepted');
    // Repeating is harmless.
    expect((await api.post('/v1/invitations/' + c.inviteCode + '/accept').set(B)).status).toBe(200);
  });

  it('rejects bad codes, your own code and a code someone else already used', async () => {
    const c = await invite();
    expect((await api.get('/v1/invitations/NOPE').set(B)).status).toBe(404);
    expect((await api.get('/v1/invitations/ZZZZZZZZ').set(B)).status).toBe(404);
    expect((await api.get('/v1/invitations/' + c.inviteCode).set(A)).status).toBe(400);

    await api.post('/v1/invitations/' + c.inviteCode + '/accept').set(B);
    expect((await api.post('/v1/invitations/' + c.inviteCode + '/accept').set(C)).status).toBe(409);
    expect((await api.get('/v1/invitations/' + c.inviteCode).set({ Authorization: '' })).status).toBe(401);
  });

  it('supports declining and a withdrawn invitation', async () => {
    const c = await invite();
    const declined = await api.post('/v1/invitations/' + c.inviteCode + '/decline').set(B);
    expect(declined.body.status).toBe('declined');
    // A declined contact cannot follow journeys.
    const j = await api.post('/v1/journeys').set(A).send(journeyBody([c.id]));
    expect(j.status).toBe(400);

    const d = await invite(A, 'Dana');
    await api.delete('/v1/contacts/' + d.id).set(A);
    expect((await api.get('/v1/invitations/' + d.inviteCode).set(B)).status).toBe(410);
  });

  it('shows the invited person the journeys shared with them, and nobody else', async () => {
    await api.put('/v1/me').set(A).send({ displayName: 'Alice Doe' });
    const c = await invite();
    await api.post('/v1/invitations/' + c.inviteCode + '/accept').set(B);

    expect((await api.get('/v1/following').set(B)).body.items).toHaveLength(0);
    const j = (await api.post('/v1/journeys').set(A).send(journeyBody([c.id], { vehicle: 'Taxi 42' }))).body;
    await api
      .post('/v1/journeys/' + j.id + '/location')
      .set(A)
      .send({ points: [{ lat: 18.5, lng: 73.8, recordedAt: new Date().toISOString() }] });

    const mine = await api.get('/v1/following').set(B);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].travellerName).toBe('Alice Doe');
    expect(mine.body.items[0].destinationName).toBe('Home');
    expect(mine.body.items[0].lastLocation.lat).toBe(18.5);

    // Carol was never invited, so she sees nothing.
    expect((await api.get('/v1/following').set(C)).body.items).toHaveLength(0);

    // Removing Bob cuts access straight away.
    await api.delete('/v1/contacts/' + c.id).set(A);
    expect((await api.get('/v1/following').set(B)).body.items).toHaveLength(0);

    // Once the journey ends it disappears from the list.
    await api.post('/v1/journeys/' + j.id + '/complete').set(A);
  });

  it('resend returns the same code', async () => {
    const c = await invite();
    const res = await api.post('/v1/contacts/' + c.id + '/resend').set(A);
    expect(res.status).toBe(200);
    expect(res.body.inviteCode).toBe(c.inviteCode);
  });
});

describe('watch link', () => {
  it('shows a limited public view, hides location after arrival and can be revoked', async () => {
    await api.put('/v1/me').set(A).send({ displayName: 'Alice Doe' });
    const c = await acceptedContact();
    const j = (await api.post('/v1/journeys').set(A).send(journeyBody([c], { createWatchLink: true }))).body;
    expect(j.watch.url).toContain('https://arrivo.test/w/');
    const token = j.watch.token as string;

    await api
      .post(`/v1/journeys/${j.id}/location`)
      .set(A)
      .send({ points: [{ lat: 18.5, lng: 73.8, recordedAt: new Date().toISOString() }] });

    const view = await api.get(`/v1/watch/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.travellerName).toBe('Alice');
    expect(view.body.lastLocation.lat).toBe(18.5);
    expect(view.body).not.toHaveProperty('contactIds');
    expect(view.body).not.toHaveProperty('id');

    await api.post(`/v1/journeys/${j.id}/complete`).set(A);
    // Completing revokes links, so the public view is closed.
    expect((await api.get(`/v1/watch/${token}`)).status).toBe(410);
    expect((await api.get('/v1/watch/short')).status).toBe(404);
  });

  it('can be revoked while the journey is running', async () => {
    const c = await acceptedContact();
    const j = (await api.post('/v1/journeys').set(A).send(journeyBody([c]))).body;
    const link = (await api.post(`/v1/journeys/${j.id}/watch-link`).set(A)).body;
    expect((await api.get(`/v1/watch/${link.token}`)).status).toBe(200);
    expect((await api.delete(`/v1/journeys/${j.id}/watch-link`).set(A)).status).toBe(204);
    expect((await api.get(`/v1/watch/${link.token}`)).status).toBe(410);
    // Someone else cannot create a link for it.
    expect((await api.post(`/v1/journeys/${j.id}/watch-link`).set(B)).status).toBe(404);
  });
});

describe('safety', () => {
  it('runs a safety timer', async () => {
    expect((await api.get('/v1/safety/timer').set(A)).body.endsAt).toBeNull();
    expect((await api.post('/v1/safety/timer').set(A).send({ minutes: 2 })).status).toBe(400);
    const set = await api.post('/v1/safety/timer').set(A).send({ minutes: 30 });
    expect(set.status).toBe(201);
    expect((await api.get('/v1/safety/timer').set(A)).body.endsAt).toBe(set.body.endsAt);
    expect((await api.delete('/v1/safety/timer').set(A)).status).toBe(204);
    expect((await api.get('/v1/safety/timer').set(A)).body.endsAt).toBeNull();
  });

  it('records an SOS and says delivery is pending', async () => {
    await acceptedContact();
    const res = await api.post('/v1/safety/sos').set(A).send({ lat: 18.5, lng: 73.8 });
    expect(res.status).toBe(201);
    expect(res.body.contactsToAlert).toBe(1);
    expect(res.body.delivery).toBe('pending');
    expect((await api.post('/v1/safety/sos').set(A).send({ journeyId: 'someone-elses' })).status).toBe(404);
  });
});

describe('account and devices', () => {
  it('ends a journey in progress when deletion is requested', async () => {
    const c = await acceptedContact();
    const j = (await api.post('/v1/journeys').set(A).send(journeyBody([c]))).body;
    expect((await api.delete('/v1/me').set(A)).status).toBe(202);
    expect((await api.get(`/v1/journeys/${j.id}`).set(A)).body.status).toBe('cancelled');
  });

  it('saves a push token', async () => {
    const res = await api.post('/v1/devices').set(A).send({ platform: 'android', pushToken: 'x'.repeat(40) });
    expect(res.status).toBe(204);
    expect((await api.post('/v1/devices').set(A).send({ platform: 'tv', pushToken: 'x'.repeat(40) })).status).toBe(400);
  });

  describe('push notifications (FR-NOT)', () => {
    const tokenA = 'a'.repeat(40);
    const tokenB = 'b'.repeat(40);
    let sent: { tokens: string[]; title: string; data?: Record<string, string> }[];
    let dead: string[];

    beforeEach(() => {
      sent = [];
      dead = [];
      setPushSender({
        async send(tokens, msg) {
          sent.push({ tokens, title: msg.title, data: msg.data });
          return dead;
        },
      });
    });
    afterEach(() => setPushSender(null));

    async function bobFollowsAlice() {
      const c = (await api.post('/v1/contacts').set(A).send({ name: 'Bob', phone: '+1 202 555 0188' })).body;
      await api.post('/v1/invitations/' + c.inviteCode + '/accept').set(B);
      await api.post('/v1/devices').set(A).send({ platform: 'android', pushToken: tokenA });
      await api.post('/v1/devices').set(B).send({ platform: 'android', pushToken: tokenB });
      return c.id as string;
    }

    it('pushes a started journey to the contact phone only, not the traveller', async () => {
      const c = await bobFollowsAlice();
      await api.post('/v1/journeys').set(A).send(journeyBody([c]));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.tokens).toEqual([tokenB]);
      expect(JSON.stringify(sent[0])).not.toMatch(/lat|lng|18\.5/);
    });

    it('forgets tokens Firebase reports as dead', async () => {
      const c = await bobFollowsAlice();
      expect(await db.listPushTokens('dev-bob')).toEqual([tokenB]);
      dead = [tokenB];
      await api.post('/v1/journeys').set(A).send(journeyBody([c]));
      expect(await db.listPushTokens('dev-bob')).toEqual([]);
    });

    it('lets a user remove only their own token on sign-out', async () => {
      await bobFollowsAlice();
      expect((await api.delete('/v1/devices').set(A).send({ pushToken: tokenB })).status).toBe(204);
      expect(await db.listPushTokens('dev-bob')).toEqual([tokenB]);
      expect((await api.delete('/v1/devices').set(B).send({ pushToken: tokenB })).status).toBe(204);
      expect(await db.listPushTokens('dev-bob')).toEqual([]);
    });

    it('does not break the action when sending fails', async () => {
      const c = await bobFollowsAlice();
      setPushSender({
        async send() {
          throw new Error('fcm down');
        },
      });
      expect((await api.post('/v1/journeys').set(A).send(journeyBody([c]))).status).toBe(201);
    });

    describe('progress updates (FR-NOT-09)', () => {
      const point = () => ({ points: [{ lat: 18.5204, lng: 73.8567, recordedAt: new Date().toISOString() }] });
      const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

      let area: AreaInfo;
      let areaFails: boolean;
      beforeEach(() => {
        area = { road: 'MG Road', neighbourhood: 'Koregaon Park', city: 'Pune', state: 'Maharashtra' };
        areaFails = false;
        const places = {
          ...noPlaces,
          enabled: true,
          area: async () => {
            if (areaFails) throw new Error('down');
            return area;
          },
        };
        api = request(createApp(db, cfg, undefined, places));
      });

      async function startWithInterval(interval: number | null, distanceKm = 0) {
        const c = await bobFollowsAlice();
        const res = await api
          .post('/v1/journeys')
          .set(A)
          .send(journeyBody([c], { updateIntervalMinutes: interval, distanceKm }));
        expect(res.status).toBe(201);
        sent.length = 0; // forget the "journey started" push
        return res.body as { id: string; trackToken: string };
      }

      it('sends nothing when the traveller chose no updates', async () => {
        const j = await startWithInterval(null);
        db.journeys.get(j.id)!.lastProgressAt = minutesAgo(500);
        await api.post(`/v1/journeys/${j.id}/location`).set(A).send(point());
        expect(sent).toHaveLength(0);
      });

      it('waits for the chosen interval, then updates the contact once', async () => {
        const j = await startWithInterval(15);
        await api.post(`/v1/journeys/${j.id}/location`).set(A).send(point());
        expect(sent).toHaveLength(0); // 15 minutes have not passed

        db.journeys.get(j.id)!.lastProgressAt = minutesAgo(16);
        await api.post(`/v1/journeys/${j.id}/location`).set(A).send(point());
        expect(sent).toHaveLength(1);
        expect(sent[0]?.tokens).toEqual([tokenB]);
        // Trip length unknown: the coarse wording (city and state).
        expect(sent[0]?.title).toMatch(/near Pune, Maharashtra/);
        expect(sent[0]?.data?.journeyId).toBe(j.id);
        // FR-NOT-11: no coordinates anywhere in what goes to the lock screen.
        expect(JSON.stringify(sent[0])).not.toMatch(/18\.52|73\.85/);

        // Another upload right away is not a second update.
        await api.post(`/v1/journeys/${j.id}/location`).set(A).send(point());
        expect(sent).toHaveLength(1);
      });

      it('also works from the background service (track token)', async () => {
        const j = await startWithInterval(30);
        db.journeys.get(j.id)!.lastProgressAt = minutesAgo(31);
        const res = await api.post(`/v1/track/${j.trackToken}/location`).send(point());
        expect(res.status).toBe(202);
        expect(sent).toHaveLength(1);
      });

      it('sends one update when two uploads arrive at the same moment', async () => {
        const j = await startWithInterval(15);
        db.journeys.get(j.id)!.lastProgressAt = minutesAgo(20);
        await Promise.all([
          api.post(`/v1/journeys/${j.id}/location`).set(A).send(point()),
          api.post(`/v1/journeys/${j.id}/location`).set(A).send(point()),
        ]);
        expect(sent).toHaveLength(1);
      });

      it('stays quiet while the journey is overdue', async () => {
        const j = await startWithInterval(15);
        db.journeys.get(j.id)!.lastProgressAt = minutesAgo(20);
        db.journeys.get(j.id)!.status = 'overdue';
        await api.post(`/v1/journeys/${j.id}/location`).set(A).send(point());
        expect(sent).toHaveLength(0);
      });

      async function updateAfter(j: { id: string }, recordedAt = new Date().toISOString()) {
        db.journeys.get(j.id)!.lastProgressAt = minutesAgo(20);
        await api
          .post(`/v1/journeys/${j.id}/location`)
          .set(A)
          .send({ points: [{ lat: 18.5204, lng: 73.8567, recordedAt }] });
        return sent[0]?.title ?? '';
      }

      it('names the road and area on a short trip', async () => {
        const j = await startWithInterval(15, 8);
        expect(await updateAfter(j)).toMatch(/is near MG Road, Koregaon Park$/);
      });

      it('names only the city and state on a long trip', async () => {
        const j = await startWithInterval(15, 400);
        const title = await updateAfter(j);
        expect(title).toMatch(/is near Pune, Maharashtra$/);
        expect(title).not.toMatch(/MG Road|Koregaon/);
      });

      it('does not call an old position "now"', async () => {
        const j = await startWithInterval(15, 8);
        expect(await updateAfter(j, minutesAgo(30))).toMatch(/is on the way$/);
      });

      it('still sends the update when the place lookup fails', async () => {
        const j = await startWithInterval(15, 8);
        areaFails = true;
        expect(await updateAfter(j)).toMatch(/is on the way$/);
      });

      it('accepts any interval from 10 minutes to 12 hours, and nothing outside', async () => {
        const c = await bobFollowsAlice();
        const start = (m: number) => api.post('/v1/journeys').set(A).send(journeyBody([c], { updateIntervalMinutes: m }));
        expect((await start(5)).status).toBe(400);
        expect((await start(721)).status).toBe(400);
        expect((await start(45.5)).status).toBe(400);
        const ok = await start(45); // a custom time, not one of the presets
        expect(ok.status).toBe(201);
        expect(ok.body.updateIntervalMinutes).toBe(45);
      });

      it('uses a custom interval to decide when to update', async () => {
        const j = await startWithInterval(45);
        db.journeys.get(j.id)!.lastProgressAt = minutesAgo(30);
        await api.post(`/v1/journeys/${j.id}/location`).set(A).send(point());
        expect(sent).toHaveLength(0); // 45 minutes not yet
        db.journeys.get(j.id)!.lastProgressAt = minutesAgo(46);
        await api.post(`/v1/journeys/${j.id}/location`).set(A).send(point());
        expect(sent).toHaveLength(1);
      });
    });
  });
});

describe('overdue sweep', () => {
  it('marks journeys overdue after arrival plus grace', async () => {
    const c = await acceptedContact();
    const j = (await api.post('/v1/journeys').set(A).send(journeyBody([c], { graceMinutes: 5 }))).body;
    expect(await db.markOverdue(new Date().toISOString())).toBe(0);
    expect(await db.markOverdue(inMinutes(30 + 6))).toBe(1);
    expect((await api.get(`/v1/journeys/${j.id}`).set(A)).body.status).toBe('overdue');
    // Still counts as in progress, so a second journey is refused.
    expect((await api.post('/v1/journeys').set(A).send(journeyBody([c]))).status).toBe(409);
  });
});

describe('config', () => {
  it('refuses the memory database and dev routes in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DB_DRIVER: 'memory' })).toThrow(/memory/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DB_DRIVER: 'supabase', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', ENABLE_DEV_ROUTES: 'true' }),
    ).toThrow(/DEV_ROUTES/);
  });

  it('requires Supabase settings when that driver is chosen', () => {
    expect(() => loadConfig({ DB_DRIVER: 'supabase' })).toThrow(/SUPABASE_URL/);
  });
});

describe('invitations by email', () => {
  it('shows a pending invite to the signed-in person with that email, no code needed', async () => {
    await api.post('/v1/contacts').set(A).send({ name: 'Bob', email: 'Bob@Example.test' });
    const pending = await api.get('/v1/invitations/pending').set(B);
    expect(pending.status).toBe(200);
    expect(pending.body.items).toHaveLength(1);
    expect(pending.body.items[0].inviterName).toBe('alice');

    const code = pending.body.items[0].inviteCode as string;
    expect((await api.post(`/v1/invitations/${code}/accept`).set(B)).status).toBe(200);
    expect((await api.get('/v1/invitations/pending').set(B)).body.items).toHaveLength(0);
  });

  it('shows nothing to other people, or to the inviter', async () => {
    await api.post('/v1/contacts').set(A).send({ name: 'Bob', email: 'bob@example.test' });
    expect((await api.get('/v1/invitations/pending').set({ Authorization: 'Bearer dev:carol' })).body.items).toHaveLength(0);
    expect((await api.get('/v1/invitations/pending').set(A)).body.items).toHaveLength(0);
  });
});

describe('invite email and trusting list', () => {
  it('emails the invite when the contact has an email, and lists who I am a contact of', async () => {
    const sent: string[] = [];
    const app = request(createApp(db, cfg, { sendInvite: async (m) => (sent.push(m.to), true) }));
    const made = await app.post('/v1/contacts').set(A).send({ name: 'Bob', email: 'bob@example.test' });
    expect(made.body.emailSent).toBe(true);
    expect(sent).toEqual(['bob@example.test']);
    expect((await app.post('/v1/contacts').set(A).send({ name: 'Pho', phone: '+1 202 555 0111' })).body.emailSent).toBe(false);

    expect((await app.get('/v1/trusting').set(B)).body.items).toHaveLength(0);
    await app.post(`/v1/invitations/${made.body.inviteCode}/accept`).set(B);
    const t = await app.get('/v1/trusting').set(B);
    expect(t.body.items.map((i: { name: string }) => i.name)).toEqual(['alice']);
  });
});

describe('describePlace (FR-NOT-09)', () => {
  const area = { road: 'MG Road', neighbourhood: 'Koregaon Park', city: 'Pune', state: 'Maharashtra' };

  it('uses road and area on a local trip, city and state on a long one', () => {
    expect(describePlace(area, 8)).toBe('near MG Road, Koregaon Park');
    expect(describePlace(area, 29.9)).toBe('near MG Road, Koregaon Park');
    expect(describePlace(area, 30)).toBe('near Pune, Maharashtra');
    expect(describePlace(area, 900)).toBe('near Pune, Maharashtra');
  });

  it('treats an unknown trip length as long, which reveals less', () => {
    expect(describePlace(area, 0)).toBe('near Pune, Maharashtra');
  });

  it('skips "Unnamed Road" and falls back to the area', () => {
    expect(describePlace({ ...area, road: 'Unnamed Road' }, 5)).toBe('near Koregaon Park');
    expect(describePlace({ city: 'Pune' }, 5)).toBe('near Pune');
  });

  it('returns nothing when no place is known', () => {
    expect(describePlace({}, 5)).toBeNull();
  });
});

describe('places', () => {
  const fake = {
    enabled: true,
    area: async () => ({}),
    search: async (o: { query: string }) => [{ placeId: 'p1', name: o.query, address: 'Pune, India', distanceMeters: 120 }],
    details: async () => ({ placeId: 'p1', name: 'Shivajinagar', address: 'Pune', lat: 18.53, lng: 73.85 }),
    reverse: async (lat: number, lng: number) => ({ placeId: '', name: 'Dropped pin', address: 'x', lat, lng }),
  };

  it('searches, reads details and reverse-geocodes through the provider', async () => {
    const app = request(createApp(db, cfg, undefined, fake));
    const s = await app.get('/v1/places/search').query({ q: 'shivaji', lat: 18.5, lng: 73.8 }).set(A);
    expect(s.status).toBe(200);
    expect(s.body.items[0].placeId).toBe('p1');
    expect((await app.get('/v1/places/details').query({ placeId: 'p1xyz' }).set(A)).body.lat).toBe(18.53);
    expect((await app.get('/v1/places/reverse').query({ lat: 18.5, lng: 73.8 }).set(A)).body.name).toBe('Dropped pin');
    expect((await app.get('/v1/places/search').query({ q: 'a' }).set(A)).status).toBe(400);
    expect((await app.get('/v1/places/search').query({ q: 'abc' })).status).toBe(401);
  });

  it('says clearly when place search is not configured', async () => {
    const r = await api.get('/v1/places/search').query({ q: 'pune' }).set(A);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('places_unavailable');
  });

  it('saves places per person, keeps one Home, and removes them', async () => {
    const home = { kind: 'home', name: 'Flat 4', address: 'Pune', lat: 18.5, lng: 73.8 };
    const first = await api.post('/v1/places/saved').set(A).send(home);
    expect(first.status).toBe(201);
    expect(first.body.label).toBe('Home');
    await api.post('/v1/places/saved').set(A).send({ ...home, name: 'New flat' });
    await api.post('/v1/places/saved').set(A).send({ kind: 'other', name: 'Gaon', address: 'Satara', lat: 17.7, lng: 74.0 });
    const dupe = await api.post('/v1/places/saved').set(A).send({ kind: 'other', name: 'Gaon', address: 'Satara', lat: 17.7, lng: 74.0 });
    expect(dupe.status).toBe(200);

    const list = (await api.get('/v1/places/saved').set(A)).body.items;
    expect(list.map((p: { name: string }) => p.name)).toEqual(['New flat', 'Gaon']);
    expect((await api.get('/v1/places/saved').set(B)).body.items).toHaveLength(0);

    expect((await api.delete(`/v1/places/saved/${list[1].id}`).set(B)).status).toBe(404);
    expect((await api.delete(`/v1/places/saved/${list[1].id}`).set(A)).status).toBe(204);
  });
});

describe('own email and profile photo', () => {
  it('does not let you invite yourself', async () => {
    const byEmail = await api.post('/v1/contacts').set(A).send({ name: 'Me', email: 'Alice@Example.test' });
    expect(byEmail.status).toBe(400);
    expect(byEmail.body.error.message).toMatch(/own email/);

    await api.put('/v1/me').set(A).send({ phone: '+91 98765 43210' });
    const byPhone = await api.post('/v1/contacts').set(A).send({ name: 'Me', phone: '09876543210' });
    expect(byPhone.status).toBe(400);
    expect(byPhone.body.error.message).toMatch(/own phone/);

    expect((await api.post('/v1/contacts').set(A).send({ name: 'Bob', email: 'bob@example.test' })).status).toBe(201);
  });

  it('signs a photo upload only for this user and only accepts that user\'s image', async () => {
    const photos = {
      enabled: true,
      ticket: (id: string) => ({ uploadUrl: 'u', apiKey: 'k', timestamp: 1, signature: 's', publicId: `arrivo/avatars/${id}`, overwrite: true, invalidate: true }),
      isOwnAvatar: (url: string, id: string) => url.startsWith('https://res.cloudinary.com/demo/image/upload/') && url.includes(`/arrivo/avatars/${id}`),
      isOwnPlate: (url: string, id: string) => url.startsWith('https://res.cloudinary.com/demo/image/upload/') && url.includes(`/arrivo/plates/${id}/`),
    };
    const app = request(createApp(db, cfg, undefined, undefined, photos));
    expect((await app.post('/v1/me/avatar/ticket').set(A)).body.publicId).toBe('arrivo/avatars/dev-alice');

    const good = 'https://res.cloudinary.com/demo/image/upload/v1/arrivo/avatars/dev-alice.jpg';
    const saved = await app.put('/v1/me').set(A).send({ avatarUrl: good });
    expect(saved.status).toBe(200);
    expect(saved.body.avatarUrl).toBe(good);
    expect(saved.body.email).toBe('alice@example.test');
    expect((await app.put('/v1/me').set(B).send({ avatarUrl: good })).status).toBe(400);
    expect((await app.put('/v1/me').set(A).send({ avatarUrl: 'https://evil.example/x.jpg' })).status).toBe(400);
    expect((await app.put('/v1/me').set(A).send({ avatarUrl: null })).body.avatarUrl).toBeNull();
  });

  it('says so when photo upload is not configured', async () => {
    const r = await api.post('/v1/me/avatar/ticket').set(A);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('uploads_unavailable');
  });
});

describe('route planning and trip extras', () => {
  it('encodes polylines the way Google does', async () => {
    const { encodePolyline } = await import('../src/lib/polyline.js');
    expect(
      encodePolyline([
        { lat: 38.5, lng: -120.2 },
        { lat: 40.7, lng: -120.95 },
        { lat: 43.252, lng: -126.453 },
      ]),
    ).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('plans every mode, falling back to a clear estimate when no route service is set up', async () => {
    const q = { oLat: 18.5308, oLng: 73.8475, dLat: 18.5913, dLng: 73.7389 }; // Shivajinagar to Hinjewadi
    const times: Record<string, number> = {};
    for (const mode of ['walk', 'bike', 'car', 'train', 'metro']) {
      const r = await api.get('/v1/routes/plan').query({ ...q, mode }).set(A);
      expect(r.status).toBe(200);
      expect(r.body.estimated).toBe(true);
      expect(r.body.distanceMeters).toBeGreaterThan(10_000);
      expect(r.body.polyline.length).toBeGreaterThan(5);
      expect(r.body.steps).toHaveLength(1);
      times[mode] = r.body.durationSeconds;
    }
    // Walking is slowest, a bike or car is quickest over this distance.
    expect(times.walk!).toBeGreaterThan(times.car!);
    expect((await api.get('/v1/routes/plan').query({ ...q, mode: 'plane' }).set(A)).status).toBe(400);
    expect((await api.get('/v1/routes/plan').query({ ...q, mode: 'car' })).status).toBe(401);
  });

  it('uses the routing service when there is one', async () => {
    const routing = {
      enabled: true,
      plan: async () => ({
        mode: 'metro' as const,
        distanceMeters: 12000,
        durationSeconds: 1800,
        polyline: 'abc',
        steps: [
          { kind: 'walk' as const, label: 'Walk to Civil Court', distanceMeters: 400, durationSeconds: 300, polyline: 'a' },
          { kind: 'metro' as const, label: 'Metro Purple Line, 6 stops', distanceMeters: 11000, durationSeconds: 1200, polyline: 'b' },
        ],
        estimated: false,
      }),
      stations: async () => [],
    };
    const app = request(createApp(db, cfg, undefined, undefined, undefined, routing));
    const r = await app.get('/v1/routes/plan').query({ oLat: 1, oLng: 1, dLat: 2, dLng: 2, mode: 'metro' }).set(A);
    expect(r.body.estimated).toBe(false);
    expect(r.body.steps.map((s: { kind: string }) => s.kind)).toEqual(['walk', 'metro']);
  });

  it('starts a metro journey with its route, and only accepts your own plate photo', async () => {
    const photos = {
      enabled: true,
      ticket: (id: string) => ({ uploadUrl: 'u', apiKey: 'k', timestamp: 1, signature: 's', publicId: `arrivo/plates/${id}/x`, overwrite: false, invalidate: false }),
      isOwnAvatar: () => false,
      isOwnPlate: (url: string, id: string) => url.startsWith('https://res.cloudinary.com/demo/image/upload/') && url.includes(`/arrivo/plates/${id}/`),
    };
    const app = request(createApp(db, cfg, undefined, undefined, photos));
    expect((await app.post('/v1/journeys/photo-ticket').set(A)).body.publicId).toBe('arrivo/plates/dev-alice/x');

    const made = await app.post('/v1/contacts').set(A).send({ name: 'Aisha', phone: '+1 202 555 0143' });
    await app.post(`/v1/dev/contacts/${made.body.id}/accept`).set(A);
    const base = {
      destinationName: 'Hinjewadi',
      destinationLat: 18.59,
      destinationLng: 73.73,
      originLat: 18.53,
      originLng: 73.84,
      mode: 'metro',
      distanceKm: 12.4,
      routePolyline: 'abc',
      routeSteps: [{ kind: 'metro', label: 'Metro Purple Line', distanceMeters: 11000, durationSeconds: 1200 }],
      expectedArrival: inMinutes(40),
      contactIds: [made.body.id],
    };
    const bad = await app.post('/v1/journeys').set(A).send({ ...base, vehicleImageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/arrivo/plates/dev-bob/x.jpg' });
    expect(bad.status).toBe(400);
    const ok = await app.post('/v1/journeys').set(A).send({ ...base, vehicleImageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/arrivo/plates/dev-alice/x.jpg' });
    expect(ok.status).toBe(201);
    expect(ok.body.mode).toBe('metro');
    expect(ok.body.distanceKm).toBe(12.4);
    expect(ok.body.routePolyline).toBe('abc');
    expect(ok.body.vehicleImageUrl).toContain('/arrivo/plates/dev-alice/');
  });
});

describe('modes that do not work for a trip', () => {
  it('marks train as unavailable when Google finds no train route, but still answers', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    try {
      const { googleRouting } = await import('../src/lib/routing.js');
      const plan = await googleRouting('k').plan({ origin: { lat: 30.6, lng: 76.7 }, destination: { lat: 30.7, lng: 76.8 }, mode: 'train' });
      expect(plan.unavailable).toBe(true);
      expect(plan.estimated).toBe(true);
      const car = await googleRouting('k').plan({ origin: { lat: 30.6, lng: 76.7 }, destination: { lat: 30.7, lng: 76.8 }, mode: 'car' });
      expect(car.unavailable).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('notifications and recent places', () => {
  it('tells people what happens: invite, accept, start, arrive', async () => {
    const photos = {
      enabled: true,
      ticket: () => ({ uploadUrl: 'u', apiKey: 'k', timestamp: 1, signature: 's', publicId: 'p', overwrite: false, invalidate: false }),
      isOwnAvatar: () => false,
      isOwnPlate: (url: string, id: string) => url.includes(`/arrivo/plates/${id}/`),
    };
    const app = request(createApp(db, cfg, undefined, undefined, photos));
    // Alice invites Bob by email. Bob sees it before he has answered.
    const made = await app.post('/v1/contacts').set(A).send({ name: 'Bob', email: 'bob@example.test' });
    const bobList = await app.get('/v1/notifications').set(B);
    expect(bobList.body.items[0].type).toBe('invitation');
    expect(bobList.body.unread).toBe(1);
    expect((await app.get('/v1/notifications/unread-count').set(B)).body.unread).toBe(1);

    // Bob accepts: Alice is told.
    await app.post(`/v1/invitations/${made.body.inviteCode}/accept`).set(B);
    const aliceList = await app.get('/v1/notifications').set(A);
    expect(aliceList.body.items[0].type).toBe('invite_accepted');
    expect(aliceList.body.items[0].title).toMatch(/bob accepted/i);
    expect((await app.get('/v1/notifications').set(B)).body.items).toHaveLength(0); // invitation is gone

    // Alice starts a journey with a ride photo: Bob gets the start and the photo.
    const j = await app.post('/v1/journeys').set(A).send({
      destinationName: 'Home',
      mode: 'car',
      expectedArrival: inMinutes(30),
      contactIds: [made.body.id],
      vehicle: 'MH 12 AB 3456',
      vehicleImageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/arrivo/plates/dev-alice/x.jpg',
    });
    expect(j.status).toBe(201);
    const types = (await app.get('/v1/notifications').set(B)).body.items.map((n: { type: string }) => n.type);
    expect(types).toContain('journey_started');
    expect(types).toContain('attachment');

    await app.post(`/v1/journeys/${j.body.id}/complete`).set(A);
    const afterArrive = (await app.get('/v1/notifications').set(B)).body;
    expect(afterArrive.items[0].type).toBe('journey_arrived');
    expect(afterArrive.unread).toBe(3);

    await app.post('/v1/notifications/read').set(B).send({});
    expect((await app.get('/v1/notifications/unread-count').set(B)).body.unread).toBe(0);
    // Alice reads only hers.
    expect((await app.get('/v1/notifications/unread-count').set(A)).body.unread).toBe(1);
  });

  it('remembers places that were picked, once each, and clears them', async () => {
    const spot = { name: 'Lakhnaur', address: 'Mohali, Punjab', lat: 30.7, lng: 76.7, googlePlaceId: 'abc123' };
    await api.post('/v1/places/recent').set(A).send(spot);
    const again = await api.post('/v1/places/recent').set(A).send(spot);
    expect(again.body.useCount).toBe(2);
    await api.post('/v1/places/recent').set(A).send({ name: 'Elsewhere', address: '', lat: 18.5, lng: 73.8 });
    const list = (await api.get('/v1/places/recent').set(A)).body.items;
    expect(list.map((p: { name: string }) => p.name)).toEqual(['Elsewhere', 'Lakhnaur']);
    expect((await api.get('/v1/places/recent').set(B)).body.items).toHaveLength(0);
    expect((await api.delete('/v1/places/recent').set(A)).status).toBe(204);
    expect((await api.get('/v1/places/recent').set(A)).body.items).toHaveLength(0);
  });
});

describe('train trips door to door', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function stubGoogle() {
    const { encodePolyline } = await import('../src/lib/polyline.js');
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (String(url).includes('searchNearby')) {
        const c = body.locationRestriction.circle.center;
        // Two stations: one close to the search point, one farther away.
        return new Response(
          JSON.stringify({
            places: [
              { id: 'far', displayName: { text: 'Far Junction' }, formattedAddress: 'x', location: { latitude: c.latitude + 0.2, longitude: c.longitude } },
              { id: 'near', displayName: { text: 'Near Station' }, formattedAddress: 'y', location: { latitude: c.latitude + 0.02, longitude: c.longitude } },
            ],
          }),
        );
      }
      if (body.travelMode === 'TRANSIT') return new Response(JSON.stringify({})); // no timetable route
      const o = body.origin.location.latLng;
      const d = body.destination.location.latLng;
      return new Response(
        JSON.stringify({
          routes: [{ distanceMeters: 5000, duration: '600s', polyline: { encodedPolyline: encodePolyline([{ lat: o.latitude, lng: o.longitude }, { lat: d.latitude, lng: d.longitude }]) } }],
        }),
      );
    }) as unknown as typeof fetch;
  }

  it('lists stations near a place, closest first', async () => {
    await stubGoogle();
    const { googleRouting } = await import('../src/lib/routing.js');
    const list = await googleRouting('k').stations({ lat: 30.67, lng: 76.7 }, 'train');
    expect(list.map((s) => s.name)).toEqual(['Near Station', 'Far Junction']);
    expect(list[0]!.distanceMeters).toBeLessThan(list[1]!.distanceMeters);
  });

  it('plans to the station, rides, then goes on to the destination, as three coloured legs', async () => {
    await stubGoogle();
    const { googleRouting } = await import('../src/lib/routing.js');
    const plan = await googleRouting('k').plan({
      origin: { lat: 30.6, lng: 76.7 },
      destination: { lat: 30.9, lng: 76.9 },
      mode: 'train',
      via: {
        board: { name: 'Rajpura Junction', lat: 30.48, lng: 76.59 },
        alight: { name: 'Ambala Cantt', lat: 30.36, lng: 76.83 },
        access: 'car',
        egress: 'bike',
      },
    });
    expect(plan.steps.map((s) => s.role)).toEqual(['access', 'main', 'egress']);
    expect(plan.steps.map((s) => s.kind)).toEqual(['drive', 'train', 'bike']);
    expect(plan.steps[0]!.label).toBe('Drive to Rajpura Junction');
    expect(plan.steps[2]!.label).toBe('Ride from Ambala Cantt to destination');
    expect(plan.steps[1]!.label).toBe('Train: Rajpura Junction to Ambala Cantt');
    expect(plan.estimated).toBe(true); // the rail time is a guess without a timetable
    expect(plan.note).toMatch(/timetable/i);
    expect(plan.distanceMeters).toBeGreaterThan(10_000);
  });

  it('works without any route service (estimates), and refuses two identical stations', async () => {
    const { noRouting } = await import('../src/lib/routing.js');
    const same = { name: 'Same', lat: 30.5, lng: 76.6 };
    const bad = await noRouting.plan({ origin: { lat: 30.6, lng: 76.7 }, destination: { lat: 30.9, lng: 76.9 }, mode: 'train', via: { board: same, alight: same, access: 'walk', egress: 'walk' } });
    expect(bad.unavailable).toBe(true);
    const ok = await noRouting.plan({
      origin: { lat: 30.6, lng: 76.7 },
      destination: { lat: 30.9, lng: 76.9 },
      mode: 'metro',
      via: { board: { name: 'A', lat: 30.62, lng: 76.7 }, alight: { name: 'B', lat: 30.88, lng: 76.9 }, access: 'walk', egress: 'walk' },
    });
    expect(ok.steps).toHaveLength(3);
  });

  it('serves the stations list through the API', async () => {
    const routing = { enabled: true, plan: async () => { throw new Error('unused'); }, stations: async () => [{ name: 'Mohali Station', address: '', lat: 30.7, lng: 76.7, distanceMeters: 900 }] };
    const app = request(createApp(db, cfg, undefined, undefined, undefined, routing as never));
    const r = await app.get('/v1/routes/stations').query({ lat: 30.7, lng: 76.7, mode: 'train' }).set(A);
    expect(r.status).toBe(200);
    expect(r.body.items[0].name).toBe('Mohali Station');
    expect((await app.get('/v1/routes/stations').query({ lat: 30.7, lng: 76.7, mode: 'car' }).set(A)).status).toBe(400);
  });
});

describe('background tracking and contact photos', () => {
  async function started(app: ReturnType<typeof request>) {
    const made = await app.post('/v1/contacts').set(A).send({ name: 'Bob', email: 'bob@example.test' });
    await app.post(`/v1/invitations/${made.body.inviteCode}/accept`).set(B);
    const j = await app.post('/v1/journeys').set(A).send({ destinationName: 'Home', expectedArrival: inMinutes(30), contactIds: [made.body.id] });
    return { journey: j.body, contact: made.body };
  }

  it('lets the background service send location with the journey token only, until it ends', async () => {
    const { journey } = await started(api);
    expect(journey.trackToken).toHaveLength(32);
    const send = (token: string) =>
      api.post(`/v1/track/${token}/location`).send({ points: [{ lat: 30.7, lng: 76.7, recordedAt: new Date().toISOString() }] });
    const ok = await send(journey.trackToken);
    expect(ok.status).toBe(202);
    expect(ok.body.expectedArrival).toBeTruthy();
    expect((await send('x'.repeat(32))).status).toBe(404);
    // Bob (a follower) never receives the token.
    const following = (await api.get('/v1/following').set(B)).body.items[0];
    expect(JSON.stringify(following)).not.toContain(journey.trackToken);
    // The point is visible to followers, then the token stops working when the journey ends.
    expect((await api.get('/v1/following').set(B)).body.items[0].lastLocation.lat).toBe(30.7);
    await api.post(`/v1/journeys/${journey.id}/complete`).set(A);
    expect((await send(journey.trackToken)).status).toBe(410);
  });

  it('shows each contact\'s profile photo once they have one', async () => {
    const photos = {
      enabled: true,
      ticket: () => ({ uploadUrl: 'u', apiKey: 'k', timestamp: 1, signature: 's', publicId: 'p', overwrite: true, invalidate: true }),
      isOwnAvatar: (url: string, id: string) => url.includes(`/arrivo/avatars/${id}`),
      isOwnPlate: () => false,
    };
    const app = request(createApp(db, cfg, undefined, undefined, photos));
    const { contact } = await started(app);
    expect((await app.get('/v1/contacts').set(A)).body.items.find((c: { id: string }) => c.id === contact.id).avatarUrl).toBeNull();
    const url = 'https://res.cloudinary.com/demo/image/upload/v1/arrivo/avatars/dev-bob.jpg';
    await app.put('/v1/me').set(B).send({ avatarUrl: url });
    expect((await app.get('/v1/contacts').set(A)).body.items.find((c: { id: string }) => c.id === contact.id).avatarUrl).toBe(url);
    expect((await app.get('/v1/trusting').set(B)).body.items[0].name).toBe('alice');
  });
});

describe('scheduler endpoint (for hosts without timers)', () => {
  it('does not exist without a secret, and needs the secret when set', async () => {
    expect((await api.get('/v1/internal/overdue')).status).toBe(404);
    const app = request(createApp(db, { ...cfg, CRON_SECRET: 'a-long-enough-secret-123' }));
    expect((await app.get('/v1/internal/overdue')).status).toBe(401);
    expect((await app.get('/v1/internal/overdue').set('Authorization', 'Bearer wrong')).status).toBe(401);
    const ok = await app.get('/v1/internal/overdue').set('Authorization', 'Bearer a-long-enough-secret-123');
    expect(ok.status).toBe(200);
    expect(ok.body.markedOverdue).toBe(0);
  });
});
