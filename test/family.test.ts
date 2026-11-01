import { createHmac } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { MemoryDb } from '../src/db/memoryDb.js';
import type { BillingConfig } from '../src/lib/dodo.js';
import type { Subscription } from '../src/types.js';

const cfg = {
  CORS_ORIGINS: '',
  WATCH_BASE_URL: 'https://arrivo.test/w',
  ENABLE_DEV_ROUTES: 'true' as const,
  DB_DRIVER: 'memory' as const,
};
const SECRET_BYTES = 'test-signing-key-0123456789abcdef';
const billing: BillingConfig = {
  apiKey: 'sk_test_secret_key',
  mode: 'test',
  webhookSecret: `whsec_${Buffer.from(SECRET_BYTES).toString('base64')}`,
  products: { monthly: 'pdt_month', sixMonths: 'pdt_six', yearly: 'pdt_year', familyYearly: 'pdt_family' },
  siteUrl: 'https://site.test',
};

// Dev users: "dev:<name>" signs in as <name>@example.test, email verified.
const OWNER = { Authorization: 'Bearer dev:olivia' };
const BOB = { Authorization: 'Bearer dev:bob' };
const CAROL = { Authorization: 'Bearer dev:carol' };
const DAN = { Authorization: 'Bearer dev:dan' };
const DAY = 24 * 60 * 60 * 1000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

let db: MemoryDb;
let api: ReturnType<typeof request>;

const familySub = (userId: string, patch: Partial<Subscription> = {}): Subscription => ({
  userId,
  status: 'active',
  intervalMonths: 12,
  dodoSubscriptionId: `sub_${userId}`,
  dodoCustomerId: `cus_${userId}`,
  currentPeriodEnd: inDays(300),
  lastEventAt: new Date().toISOString(),
  planKey: 'familyYearly',
  ...patch,
});

beforeEach(async () => {
  db = new MemoryDb();
  api = request(createApp(db, cfg, undefined, undefined, undefined, undefined, billing));
  await db.upsertSubscription(familySub('dev-olivia'));
});

async function invite(email: string) {
  const r = await api.post('/v1/family/members').set(OWNER).send({ email });
  return r;
}

async function accept(headers: Record<string, string>) {
  const list = await api.get('/v1/family/invites').set(headers);
  const id = list.body.invites[0]?.id as string;
  return api.post(`/v1/family/invites/${id}/accept`).set(headers);
}

describe('Arrivo Plus Family (FR-BIL-10)', () => {
  it('is in the price list at $49 a year for 2 members', async () => {
    const r = await api.get('/v1/billing/plans');
    expect(r.body.family).toMatchObject({ key: 'familyYearly', priceCents: 4900, months: 12, members: 2, available: true });
    expect(r.body.plans.map((p: { key: string }) => p.key)).toEqual(['monthly', 'sixMonths', 'yearly']);
  });

  it('the owner is on the Family plan, with its renewal date', async () => {
    const me = await api.get('/v1/billing/me').set(OWNER);
    expect(me.body).toMatchObject({ plan: 'family', name: 'Arrivo Plus Family', planKey: 'familyYearly', canManage: true });
    expect(me.body.renewsAt).toBeTruthy();
  });

  it('a member gets Plus only after accepting, and sees whose plan it is', async () => {
    expect((await invite('bob@example.test')).status).toBe(201);
    expect((await api.get('/v1/billing/me').set(BOB)).body.plan).toBe('free');

    const list = await api.get('/v1/family/invites').set(BOB);
    expect(list.body.invites).toHaveLength(1);
    expect(list.body.invites[0].ownerName).toBe('olivia');
    expect((await accept(BOB)).status).toBe(200);

    const me = await api.get('/v1/billing/me').set(BOB);
    expect(me.body).toMatchObject({ plan: 'plus', familyMemberOf: { ownerName: 'olivia' }, canManage: false });
    expect(me.body.limits.contacts).toBe(10);
  });

  it('two places at most; never your own email or the same person twice', async () => {
    expect((await invite('olivia@example.test')).status).toBe(400);
    expect((await invite('bob@example.test')).status).toBe(201);
    expect((await invite('BOB@example.test')).status).toBe(409);
    expect((await invite('carol@example.test')).status).toBe(201);
    expect((await invite('dan@example.test')).status).toBe(409);
  });

  it('accepted members stay; only an unanswered invitation can be withdrawn', async () => {
    const b = await invite('bob@example.test');
    const c = await invite('carol@example.test');
    await accept(BOB);
    expect((await api.delete(`/v1/family/members/${b.body.id}`).set(OWNER)).status).toBe(409);
    expect((await api.delete(`/v1/family/members/${c.body.id}`).set(OWNER)).status).toBe(200);
    // The freed place can be given to someone else.
    expect((await invite('dan@example.test')).status).toBe(201);
  });

  it('only the invited person can answer, and only the owner can add or withdraw', async () => {
    const b = await invite('bob@example.test');
    expect((await api.post(`/v1/family/invites/${b.body.id}/accept`).set(CAROL)).status).toBe(404);
    expect((await api.delete(`/v1/family/members/${b.body.id}`).set(CAROL)).status).toBe(404);
    expect((await api.post('/v1/family/members').set(CAROL).send({ email: 'dan@example.test' })).status).toBe(403);
  });

  it('a Plus (not Family) subscriber cannot add members', async () => {
    await db.upsertSubscription(familySub('dev-dan', { planKey: 'yearly' }));
    expect((await api.get('/v1/billing/me').set(DAN)).body.plan).toBe('plus');
    expect((await api.post('/v1/family/members').set(DAN).send({ email: 'bob@example.test' })).status).toBe(403);
  });

  it('members drop back to Free when the owner\'s plan ends', async () => {
    await invite('bob@example.test');
    await accept(BOB);
    await db.upsertSubscription(familySub('dev-olivia', { status: 'expired' }));
    expect((await api.get('/v1/billing/me').set(BOB)).body.plan).toBe('free');
    expect((await api.get('/v1/billing/me').set(OWNER)).body.plan).toBe('free');
  });

  it('a person can be in one Family only', async () => {
    await invite('bob@example.test');
    await accept(BOB);
    await db.upsertSubscription(familySub('dev-carol'));
    await api.post('/v1/family/members').set(CAROL).send({ email: 'bob@example.test' });
    const list = await api.get('/v1/family/invites').set(BOB);
    const r = await api.post(`/v1/family/invites/${list.body.invites[0].id}/accept`).set(BOB);
    expect(r.status).toBe(409);
  });

  it('the webhook remembers that Family was bought', async () => {
    const body = {
      type: 'subscription.active',
      timestamp: new Date().toISOString(),
      data: {
        subscription_id: 'sub_new',
        product_id: 'pdt_family',
        next_billing_date: inDays(365),
        metadata: { user_id: 'dev-dan' },
        customer: { customer_id: 'cus_dan', email: 'dan@example.test' },
      },
    };
    const raw = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', Buffer.from(SECRET_BYTES)).update(`msg_f.${ts}.${raw}`).digest('base64');
    const r = await api
      .post('/v1/billing/webhook')
      .set({ 'webhook-id': 'msg_f', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` })
      .set('content-type', 'application/json')
      .send(raw);
    expect(r.status).toBe(200);
    expect((await db.getSubscription('dev-dan'))?.planKey).toBe('familyYearly');
    expect((await api.get('/v1/billing/me').set(DAN)).body.plan).toBe('family');
  });
});
