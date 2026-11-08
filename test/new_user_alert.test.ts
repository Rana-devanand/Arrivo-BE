import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { MemoryDb } from '../src/db/memoryDb.js';
import { announceNewUser } from '../src/lib/adminAlerts.js';

const cfg = {
  CORS_ORIGINS: '',
  WATCH_BASE_URL: 'https://arrivo.test/w',
  ENABLE_DEV_ROUTES: 'true' as const,
  DB_DRIVER: 'memory' as const,
};

const as = (name: string) => ({ Authorization: `Bearer dev:${name}` });

let db: MemoryDb;
let api: ReturnType<typeof request>;

beforeEach(() => {
  db = new MemoryDb();
  api = request(createApp(db, cfg));
});

/** Signs the person in once, then gives them the ADMIN role (which only a person can do in the database). */
async function makeAdmin(name: string) {
  const me = await api.get('/v1/me').set(as(name));
  const p = db.profiles.get(me.body.id);
  if (!p) throw new Error('no profile');
  p.role = 'ADMIN';
}

/** Signs several people in first and only then makes them admins, so none of them is announced to another. */
async function makeAdmins(...names: string[]) {
  for (const name of names) await api.get('/v1/me').set(as(name));
  for (const name of names) db.profiles.get(`dev-${name}`)!.role = 'ADMIN';
}

const alertsFor = async (name: string) =>
  ((await api.get('/v1/notifications').set(as(name))).body.items as { type: string; title: string; body: string; data: Record<string, unknown> }[]).filter(
    (n) => n.type === 'new_user',
  );

describe('telling the admins about a new user (FR-NOT-15)', () => {
  it('every admin gets one notification when a person signs in for the first time', async () => {
    await makeAdmins('root', 'boss');

    expect((await api.get('/v1/me').set(as('bob'))).status).toBe(200);

    for (const admin of ['root', 'boss']) {
      const alerts = await alertsFor(admin);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ title: 'New user joined Arrivo', body: 'bob just signed up.', data: { userId: 'dev-bob' } });
    }
    expect((await api.get('/v1/notifications/unread-count').set(as('root'))).body.unread).toBe(1);
  });

  it('an admin who signs in later is announced to the admins already there', async () => {
    await makeAdmin('root');
    await api.get('/v1/me').set(as('boss'));
    expect((await alertsFor('root')).map((n) => n.body)).toEqual(['boss just signed up.']);
    expect(await alertsFor('boss')).toHaveLength(0);
  });

  it('the new person and other users get nothing', async () => {
    await makeAdmin('root');
    await api.get('/v1/me').set(as('carol'));
    await api.get('/v1/me').set(as('bob'));
    expect(await alertsFor('bob')).toHaveLength(0);
    expect(await alertsFor('carol')).toHaveLength(0);
  });

  it('is sent only once per person: later requests, other endpoints and a restarted server do nothing', async () => {
    await makeAdmin('root');
    await api.get('/v1/me').set(as('bob'));
    await api.get('/v1/me').set(as('bob'));
    await api.get('/v1/contacts').set(as('bob'));
    // A fresh app on the same database: its list of known people is empty, like a server that just restarted.
    const restarted = request(createApp(db, cfg));
    await restarted.get('/v1/me').set(as('bob'));
    expect(await alertsFor('root')).toHaveLength(1);
  });

  it('two first requests arriving together still make one notification', async () => {
    await makeAdmin('root');
    await Promise.all([api.get('/v1/me').set(as('bob')), api.get('/v1/contacts').set(as('bob')), api.get('/v1/notifications').set(as('bob'))]);
    expect(await alertsFor('root')).toHaveLength(1);
  });

  it('each new person is announced once, each with their own name', async () => {
    await makeAdmin('root');
    await api.get('/v1/me').set(as('bob'));
    await api.get('/v1/me').set(as('dave'));
    const bodies = (await alertsFor('root')).map((n) => n.body).sort();
    expect(bodies).toEqual(['bob just signed up.', 'dave just signed up.']);
  });

  it('with no admin at all, signing in works and nothing is stored', async () => {
    expect((await api.get('/v1/me').set(as('bob'))).status).toBe(200);
    expect(db.listAdminIds).toBeDefined();
    expect(await db.listAdminIds()).toEqual([]);
  });

  it('an admin is never told about themselves', async () => {
    await makeAdmin('root');
    const root = db.profiles.get('dev-root')!;
    await announceNewUser(db, root);
    expect(await alertsFor('root')).toHaveLength(0);
  });

  it('the text holds the name only: no email, phone or place', async () => {
    await makeAdmin('root');
    await api.get('/v1/me').set(as('bob'));
    await api.put('/v1/me').set(as('bob')).send({ phone: '+91 98765 43210' });
    const [alert] = await alertsFor('root');
    const text = JSON.stringify(alert);
    expect(text).not.toMatch(/example\.test|@|98765/);
    expect(Object.keys(alert!.data)).toEqual(['userId']);
  });

  it('a long or empty name is handled calmly', async () => {
    await makeAdmin('root');
    const long = 'x'.repeat(200);
    await api.get('/v1/me').set(as(long));
    const [alert] = await alertsFor('root');
    expect(alert!.body.length).toBeLessThan(80);

    const nameless = { id: 'dev-nameless', displayName: '   ' } as Parameters<typeof announceNewUser>[1];
    await announceNewUser(db, nameless);
    const bodies = (await alertsFor('root')).map((n) => n.body);
    expect(bodies).toContain('Someone just signed up.');
  });

  it('a problem while telling the admins never stops anyone from signing in', async () => {
    await makeAdmin('root');
    db.listAdminIds = async () => {
      throw new Error('database down');
    };
    const res = await api.get('/v1/me').set(as('bob'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('dev-bob');
  });

  it('a rejected token is not a sign-in: nobody is told', async () => {
    await makeAdmin('root');
    expect((await api.get('/v1/me').set({ Authorization: 'Bearer nope' })).status).toBe(401);
    expect(await alertsFor('root')).toHaveLength(0);
  });
});
