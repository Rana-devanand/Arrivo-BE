import { createHmac } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { LIMITS, hasPlus } from '../src/domain/plans.js';
import { MemoryDb } from '../src/db/memoryDb.js';
import { createRatesProvider } from '../src/lib/rates.js';
import { hashTicket, type BillingConfig } from '../src/lib/dodo.js';
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
  products: { monthly: 'pdt_month', sixMonths: 'pdt_six', yearly: 'pdt_year' },
  siteUrl: 'https://site.test',
};

const DAVE = { Authorization: 'Bearer dev:dave' }; // never subscribes: Arrivo Free
const ERIN = { Authorization: 'Bearer dev:erin' };
const FRANK = { Authorization: 'Bearer dev:frank' };
const DAY = 24 * 60 * 60 * 1000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();

let db: MemoryDb;
let api: ReturnType<typeof request>;

beforeEach(() => {
  db = new MemoryDb();
  api = request(createApp(db, cfg, undefined, undefined, undefined, undefined, billing));
});
afterEach(() => vi.unstubAllGlobals());

const sub = (userId: string, patch: Partial<Subscription> = {}): Subscription => ({
  userId,
  status: 'active',
  intervalMonths: 1,
  dodoSubscriptionId: `sub_${userId}`,
  dodoCustomerId: `cus_${userId}`,
  currentPeriodEnd: inDays(20),
  lastEventAt: new Date().toISOString(),
  ...patch,
});

const addContact = (headers: Record<string, string>, n: number) =>
  api
    .post('/v1/contacts')
    .set(headers)
    .send({ name: `Person ${n}`, phone: `+91 98765 4${String(1000 + n).slice(-4)}` });

/** Signs a body the way Dodo does (Standard Webhooks). */
function signed(body: object, over: { id?: string; ts?: number; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  const id = over.id ?? 'msg_1';
  const ts = String(over.ts ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET_BYTES);
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  return { raw, headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${over.secret ?? sig}` } };
}

const send = (body: object, over: Parameters<typeof signed>[1] = {}) => {
  const { raw, headers } = signed(body, over);
  return api.post('/v1/billing/webhook').set(headers).set('content-type', 'application/json').send(raw);
};

describe('who has Arrivo Plus (FR-PLAN)', () => {
  it('active and past_due have it, until the paid time and a short grace run out', () => {
    expect(hasPlus(null)).toBe(false);
    expect(hasPlus(sub('u'))).toBe(true);
    expect(hasPlus(sub('u', { status: 'past_due' }))).toBe(true);
    // Paid time ended a day ago but a renewal webhook may be late: grace of 3 days.
    expect(hasPlus(sub('u', { currentPeriodEnd: inDays(-1) }))).toBe(true);
    expect(hasPlus(sub('u', { currentPeriodEnd: inDays(-4) }))).toBe(false);
  });

  it('a cancelled plan lasts until the time already paid for ends', () => {
    expect(hasPlus(sub('u', { status: 'cancelled', currentPeriodEnd: inDays(10) }))).toBe(true);
    expect(hasPlus(sub('u', { status: 'cancelled', currentPeriodEnd: inDays(-1) }))).toBe(false);
    expect(hasPlus(sub('u', { status: 'cancelled', currentPeriodEnd: null }))).toBe(false);
  });

  it('on hold, expired and failed give no Plus', () => {
    for (const status of ['on_hold', 'expired', 'failed'] as const) {
      expect(hasPlus(sub('u', { status }))).toBe(false);
    }
  });
});

describe('Arrivo Free allows one contact', () => {
  it('lets a Free user add one, then asks to upgrade', async () => {
    expect((await addContact(DAVE, 1)).status).toBe(201);
    const second = await addContact(DAVE, 2);
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('plan_limit');
    expect(second.body.error.message).toMatch(/Arrivo Free lets you add 1 contact. Upgrade to Arrivo Plus/);
  });

  it('a removed contact frees the place', async () => {
    const first = await addContact(DAVE, 1);
    await api.delete(`/v1/contacts/${first.body.id}`).set(DAVE);
    expect((await addContact(DAVE, 2)).status).toBe(201);
  });

  it('Plus allows more, up to its own limit', async () => {
    await db.upsertSubscription(sub('dev-erin'));
    for (let i = 1; i <= LIMITS.plus.contacts; i++) expect((await addContact(ERIN, i)).status).toBe(201);
    const over = await addContact(ERIN, 99);
    expect(over.status).toBe(403);
    expect(over.body.error.message).toMatch(/up to 10 contacts/);
  });

  it('someone who had more contacts keeps them but cannot add another', async () => {
    await db.upsertSubscription(sub('dev-erin'));
    await addContact(ERIN, 1);
    await addContact(ERIN, 2);
    await db.upsertSubscription(sub('dev-erin', { status: 'expired' })); // plan ended
    expect((await api.get('/v1/contacts').set(ERIN)).body.items).toHaveLength(2);
    expect((await addContact(ERIN, 3)).status).toBe(403);
  });
});

describe('exchange rates', () => {
  const ok = (rates: Record<string, number>) => async () => ({
    ok: true,
    json: async () => ({ result: 'success', rates }),
  });

  it('gives rates and countries without signing in, and keeps only the currencies we list', async () => {
    const fetchFn = vi.fn(ok({ INR: 84.5, EUR: 0.92, XYZ: 5 }));
    const a = request(
      createApp(db, cfg, undefined, undefined, undefined, undefined, billing, createRatesProvider({ fetchFn })),
    );
    const res = await a.get('/v1/billing/rates');
    expect(res.status).toBe(200);
    expect(res.body.live).toBe(true);
    expect(res.body.rates).toEqual({ USD: 1, INR: 84.5, EUR: 0.92 });
    expect(res.body.countries.find((c: { code: string }) => c.code === 'IN').currency).toBe('INR');
    await a.get('/v1/billing/rates');
    expect(fetchFn).toHaveBeenCalledTimes(1); // second answer comes from memory
  });

  it('offers only dollars when the rate service is down, and does not hammer it', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('down');
    });
    const a = request(
      createApp(db, cfg, undefined, undefined, undefined, undefined, billing, createRatesProvider({ fetchFn })),
    );
    const res = await a.get('/v1/billing/rates');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ live: false, rates: { USD: 1 } });
    await a.get('/v1/billing/rates');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good rates when a refresh fails', async () => {
    let t = 1_000_000;
    let fail = false;
    const fetchFn = async () => {
      if (fail) throw new Error('down');
      return { ok: true, json: async () => ({ result: 'success', rates: { INR: 80 } }) };
    };
    const get = createRatesProvider({ fetchFn, now: () => t });
    expect((await get()).rates.INR).toBe(80);
    fail = true;
    t += 13 * 60 * 60 * 1000;
    expect((await get()).rates.INR).toBe(80);
  });
});

describe('plans and my plan', () => {
  it('lists the plans and prices without signing in', async () => {
    const res = await api.get('/v1/billing/plans');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.plans.map((p: { key: string; priceCents: number }) => [p.key, p.priceCents])).toEqual([
      ['monthly', 299],
      ['sixMonths', 1499],
      ['yearly', 2499],
    ]);
    expect(res.body.currency).toBe('USD');
    expect(res.body.free.contacts).toBe(1);
    expect(res.body.plus.household).toBe(true);
    expect(res.body.free.features).toContain('1 trusted contact');
    expect(res.body.plus.features).toContain('Up to 10 trusted contacts');
    expect(res.body.plus.tagline).toBeTruthy();
    expect(res.body.plans[2].savePercent).toBe(30);
    expect(res.body.plans[2].perMonthCents).toBe(208);
  });

  it('says Free when nothing is paid, and Plus with the date when it is', async () => {
    const free = await api.get('/v1/billing/me').set(DAVE);
    expect(free.body.plan).toBe('free');
    expect(free.body.name).toBe('Arrivo Free');
    expect(free.body.limits.contacts).toBe(1);

    await db.upsertSubscription(sub('dev-erin', { intervalMonths: 12 }));
    const plus = await api.get('/v1/billing/me').set(ERIN);
    expect(plus.body.plan).toBe('plus');
    expect(plus.body.name).toBe('Arrivo Plus');
    expect(plus.body.intervalMonths).toBe(12);
    expect(plus.body.canManage).toBe(true);
  });

  it('needs sign-in to see my own plan', async () => {
    expect((await api.get('/v1/billing/me')).status).toBe(401);
  });
});

describe('paying on the website (ticket and checkout)', () => {
  it('gives a ticket that opens the website, and stores only its hash', async () => {
    const res = await api.post('/v1/billing/ticket').set(DAVE).send({ plan: 'sixMonths' });
    expect(res.status).toBe(201);
    const url = new URL(res.body.url);
    expect(url.origin + url.pathname).toBe('https://site.test/pricing');
    expect(url.searchParams.get('plan')).toBe('sixMonths');
    const token = url.searchParams.get('t')!;
    expect(db.tickets.has(token)).toBe(false); // the token itself is never stored
    expect(db.tickets.get(hashTicket(token))?.userId).toBe('dev-dave');
  });

  it('is off, with a calm message, when payments are not set up', async () => {
    const off = request(createApp(db, cfg));
    const res = await off.post('/v1/billing/ticket').set(DAVE).send({});
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/not open yet/);
    expect((await off.get('/v1/billing/plans')).body.available).toBe(false);
  });

  it('refuses a new ticket to someone who already has Plus', async () => {
    await db.upsertSubscription(sub('dev-erin'));
    expect((await api.post('/v1/billing/ticket').set(ERIN).send({})).status).toBe(409);
  });

  it('turns a ticket into a Dodo checkout with the right product, email and user', async () => {
    const ticket = new URL((await api.post('/v1/billing/ticket').set(DAVE).send({ plan: 'yearly' })).body.url).searchParams.get('t')!;
    const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
        calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization! });
        return new Response(JSON.stringify({ session_id: 'cks_1', checkout_url: 'https://checkout.dodo.test/abc' }), { status: 200 });
      }),
    );

    const res = await api.post('/v1/billing/checkout').send({ ticket });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ checkoutUrl: 'https://checkout.dodo.test/abc' });
    expect(JSON.stringify(res.body)).not.toContain('sk_test');

    expect(calls[0]!.url).toBe('https://test.dodopayments.com/checkouts');
    expect(calls[0]!.auth).toBe('Bearer sk_test_secret_key');
    expect(calls[0]!.body.product_cart).toEqual([{ product_id: 'pdt_year', quantity: 1 }]);
    expect(calls[0]!.body.customer).toMatchObject({ email: 'dave@example.test' });
    expect(calls[0]!.body.metadata).toEqual({ user_id: 'dev-dave', plan: 'yearly' });
    expect(calls[0]!.body.return_url).toBe('https://site.test/pricing/success');
    expect(db.checkouts[0]).toMatchObject({ userId: 'dev-dave', planKey: 'yearly', sessionId: 'cks_1' });
  });

  it('lets the website pick another way of paying than the ticket named', async () => {
    const ticket = new URL((await api.post('/v1/billing/ticket').set(DAVE).send({ plan: 'yearly' })).body.url).searchParams.get('t')!;
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ checkout_url: 'https://checkout.dodo.test/x' }), { status: 200 });
      }),
    );
    await api.post('/v1/billing/checkout').send({ ticket, plan: 'monthly' });
    expect(bodies[0]!.product_cart).toEqual([{ product_id: 'pdt_month', quantity: 1 }]);
  });

  it('refuses a made-up or expired ticket', async () => {
    expect((await api.post('/v1/billing/checkout').send({ ticket: 'x'.repeat(40) })).status).toBe(410);
    const ticket = new URL((await api.post('/v1/billing/ticket').set(DAVE).send({})).body.url).searchParams.get('t')!;
    db.tickets.get(hashTicket(ticket))!.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect((await api.post('/v1/billing/checkout').send({ ticket })).status).toBe(410);
  });

  it('says calmly when Dodo is down, without leaking details', async () => {
    const ticket = new URL((await api.post('/v1/billing/ticket').set(DAVE).send({})).body.url).searchParams.get('t')!;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom with sk_test_secret_key', { status: 500 })));
    const res = await api.post('/v1/billing/checkout').send({ ticket });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/sk_test|boom/);
  });
});

describe('the payment webhook (Dodo)', () => {
  const active = (extra: Record<string, unknown> = {}) => ({
    type: 'subscription.active',
    timestamp: new Date().toISOString(),
    data: {
      subscription_id: 'sub_123',
      product_id: 'pdt_six',
      customer: { customer_id: 'cus_123', email: 'dave@example.test' },
      metadata: { user_id: 'dev-dave' },
      next_billing_date: inDays(180),
      ...extra,
    },
  });

  it('turns Plus on for the person named in the metadata', async () => {
    const res = await send(active());
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('applied');
    const me = await api.get('/v1/billing/me').set(DAVE);
    expect(me.body.plan).toBe('plus');
    expect(me.body.intervalMonths).toBe(6);
    expect((await addContact(DAVE, 1)).status).toBe(201);
    expect((await addContact(DAVE, 2)).status).toBe(201); // Plus, so more than one
  });

  it('refuses an unsigned, wrongly signed, old or replayed-later webhook', async () => {
    const body = active();
    expect((await api.post('/v1/billing/webhook').send(body)).status).toBe(401); // no signature
    expect((await send(body, { secret: Buffer.from('x'.repeat(32)).toString('base64') })).status).toBe(401);
    expect((await send(body, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await api.get('/v1/billing/me').set(DAVE)).body.plan).toBe('free'); // nothing changed
  });

  it('accepts one valid signature among several', async () => {
    const { raw, headers } = signed(active());
    const res = await api
      .post('/v1/billing/webhook')
      .set({ ...headers, 'webhook-signature': `v1,AAAA ${headers['webhook-signature']}` })
      .set('content-type', 'application/json')
      .send(raw);
    expect(res.status).toBe(200);
  });

  it('finds the person by email when the provider drops our metadata', async () => {
    await db.recordCheckout({ userId: 'dev-dave', email: 'Dave@Example.test', planKey: 'monthly', sessionId: 'cks' });
    const body = active();
    delete (body.data as Record<string, unknown>).metadata;
    expect((await send(body)).body.result).toBe('applied');
    expect((await api.get('/v1/billing/me').set(DAVE)).body.plan).toBe('plus');
  });

  it('does not guess when it cannot tell who paid', async () => {
    const body = active({ customer: { customer_id: 'cus_x', email: 'stranger@example.test' } });
    delete (body.data as Record<string, unknown>).metadata;
    expect((await send(body)).body.result).toBe('unmatched');
    expect(db.subscriptions.size).toBe(0);
  });

  it('extends the paid time on a renewal and keeps it on a cancellation', async () => {
    await send(active());
    await send(
      {
        type: 'subscription.renewed',
        timestamp: new Date(Date.now() + 1000).toISOString(),
        data: { subscription_id: 'sub_123', customer: { customer_id: 'cus_123' }, next_billing_date: inDays(360) },
      },
      { id: 'msg_2' },
    );
    const renewed = db.subscriptions.get('dev-dave')!;
    expect(Date.parse(renewed.currentPeriodEnd!)).toBeGreaterThan(Date.now() + 300 * DAY);

    await send(
      {
        type: 'subscription.cancelled',
        timestamp: new Date(Date.now() + 2000).toISOString(),
        data: { subscription_id: 'sub_123', customer: { customer_id: 'cus_123' } },
      },
      { id: 'msg_3' },
    );
    const cancelled = db.subscriptions.get('dev-dave')!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.currentPeriodEnd).toBe(renewed.currentPeriodEnd); // paid time is kept, never extended
    const me = await api.get('/v1/billing/me').set(DAVE);
    expect(me.body.plan).toBe('plus');
    expect(me.body.cancelled).toBe(true);
  });

  it('ignores an older event that arrives late', async () => {
    const t = Date.now();
    await send({ ...active(), timestamp: new Date(t).toISOString() });
    const late = await send(
      { type: 'subscription.on_hold', timestamp: new Date(t - 60_000).toISOString(), data: { subscription_id: 'sub_123' } },
      { id: 'msg_2' },
    );
    expect(late.body.result).toBe('stale');
    expect(db.subscriptions.get('dev-dave')!.status).toBe('active');
  });

  it('takes Plus away when the subscription goes on hold or ends', async () => {
    await send(active());
    await send(
      { type: 'subscription.on_hold', timestamp: new Date(Date.now() + 1000).toISOString(), data: { subscription_id: 'sub_123' } },
      { id: 'msg_2' },
    );
    expect((await api.get('/v1/billing/me').set(DAVE)).body.plan).toBe('free');
  });

  it('is safe to receive twice, and ignores events that are not about subscriptions', async () => {
    await send(active());
    expect((await send(active())).status).toBe(200);
    const pay = await send({ type: 'payment.succeeded', timestamp: new Date().toISOString(), data: { payment_id: 'pay_1' } }, { id: 'msg_9' });
    expect(pay.body.result).toBe('ignored');
  });
});

describe('managing the subscription', () => {
  it('gives a portal link to someone who subscribed, and not to others', async () => {
    expect((await api.post('/v1/billing/portal').set(DAVE)).status).toBe(404);
    await db.upsertSubscription(sub('dev-erin'));
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ link: 'https://portal.dodo.test/s' }), { status: 200 });
      }),
    );
    const res = await api.post('/v1/billing/portal').set(ERIN);
    expect(res.body.url).toBe('https://portal.dodo.test/s');
    expect(urls[0]).toContain('/customers/cus_dev-erin/customer-portal/session');
  });
});

describe('Family household is Plus only', () => {
  const contactOf = async (headers: Record<string, string>, n: number) => (await addContact(headers, n)).body.id as string;

  it('is refused on Free and offered an upgrade', async () => {
    const res = await api.put('/v1/household').set(DAVE).send({ name: 'Home', contactIds: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('plan_required');
    expect(res.body.error.message).toMatch(/Arrivo Plus/);
    expect((await api.get('/v1/household').set(DAVE)).body).toEqual({ allowed: false, household: null });
  });

  it('lets a Plus member create, change and remove it', async () => {
    await db.upsertSubscription(sub('dev-erin'));
    const a = await contactOf(ERIN, 1);
    const b = await contactOf(ERIN, 2);
    const made = await api.put('/v1/household').set(ERIN).send({ name: 'The Sharmas', contactIds: [a, b, a] });
    expect(made.status).toBe(200);
    expect(made.body.household.contactIds).toEqual([a, b]); // no duplicates
    expect((await api.get('/v1/household').set(ERIN)).body.household.name).toBe('The Sharmas');

    await api.put('/v1/household').set(ERIN).send({ name: 'Family', contactIds: [b] });
    expect((await api.get('/v1/household').set(ERIN)).body.household.contactIds).toEqual([b]);

    expect((await api.delete('/v1/household').set(ERIN)).status).toBe(204);
    expect((await api.get('/v1/household').set(ERIN)).body.household).toBeNull();
  });

  it('only accepts the person\'s own contacts, and a name', async () => {
    await db.upsertSubscription(sub('dev-erin'));
    await db.upsertSubscription(sub('dev-frank'));
    const others = await contactOf(FRANK, 1);
    expect((await api.put('/v1/household').set(ERIN).send({ name: 'Home', contactIds: [others] })).status).toBe(400);
    expect((await api.put('/v1/household').set(ERIN).send({ name: '  ', contactIds: [] })).status).toBe(400);
  });

  it('keeps one person\'s household private from another', async () => {
    await db.upsertSubscription(sub('dev-erin'));
    await db.upsertSubscription(sub('dev-frank'));
    await api.put('/v1/household').set(ERIN).send({ name: 'Mine', contactIds: [] });
    expect((await api.get('/v1/household').set(FRANK)).body.household).toBeNull();
  });

  it('stays visible but locked after the plan ends', async () => {
    await db.upsertSubscription(sub('dev-erin'));
    await api.put('/v1/household').set(ERIN).send({ name: 'Mine', contactIds: [] });
    await db.upsertSubscription(sub('dev-erin', { status: 'expired' }));
    const res = await api.get('/v1/household').set(ERIN);
    expect(res.body.allowed).toBe(false);
    expect(res.body.household.name).toBe('Mine');
    expect((await api.put('/v1/household').set(ERIN).send({ name: 'New', contactIds: [] })).status).toBe(403);
  });
});
