import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { MemoryDb } from '../src/db/memoryDb.js';
import { couponStatus } from '../src/domain/coupons.js';
import type { BillingConfig } from '../src/lib/dodo.js';

const cfg = {
  CORS_ORIGINS: '',
  WATCH_BASE_URL: 'https://arrivo.test/w',
  ENABLE_DEV_ROUTES: 'true' as const,
  DB_DRIVER: 'memory' as const,
};

const billing: BillingConfig = {
  apiKey: 'sk_test_secret_key',
  mode: 'test',
  webhookSecret: 'whsec_dGVzdA==',
  products: { monthly: 'pdt_month', sixMonths: 'pdt_six', yearly: 'pdt_year' },
  siteUrl: 'https://site.test',
};

const ADMIN = { Authorization: 'Bearer dev:root' };
const USER = { Authorization: 'Bearer dev:dave' };
const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

let db: MemoryDb;
let api: ReturnType<typeof request>;
let dodo: { method: string; url: string; body: Record<string, unknown> | null }[];

/** Stands in for Dodo: records every call and answers like it would. */
function stubDodo(over: { failDiscount?: boolean; failDelete?: boolean } = {}) {
  dodo = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      const method = init.method ?? 'GET';
      dodo.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith('/discounts') && method === 'POST') {
        if (over.failDiscount) return new Response('{}', { status: 500 });
        return new Response(JSON.stringify({ discount_id: 'dsc_1' }), { status: 200 });
      }
      if (url.includes('/discounts/') && method === 'DELETE') {
        return over.failDelete ? new Response('{}', { status: 500 }) : new Response(null, { status: 204 });
      }
      if (url.endsWith('/checkouts')) return new Response(JSON.stringify({ session_id: 'cks_1', checkout_url: 'https://checkout.dodo.test/x' }), { status: 200 });
      return new Response('{}', { status: 404 });
    }),
  );
}

beforeEach(async () => {
  db = new MemoryDb();
  api = request(createApp(db, cfg, undefined, undefined, undefined, undefined, billing));
  const me = await api.get('/v1/me').set(ADMIN);
  db.profiles.get(me.body.id)!.role = 'ADMIN';
  stubDodo();
});
afterEach(() => vi.unstubAllGlobals());

const offer = (over: Record<string, unknown> = {}) => ({ code: 'LAUNCH20', title: 'Launch offer', percentOff: 20, endsAt: inHours(24), ...over });
const make = (over: Record<string, unknown> = {}) => api.post('/v1/admin/coupons').set(ADMIN).send(offer(over));
const seed = (over: Partial<Parameters<MemoryDb['createCoupon']>[0]> = {}) =>
  db.createCoupon({ code: 'OLDONE', title: 'Old', percentOff: 10, startsAt: inHours(-48), endsAt: inHours(-24), dodoDiscountId: 'dsc_x', active: true, createdBy: 'dev-root', ...over });

describe('who may manage offers', () => {
  it('needs a sign-in, and only an admin may list, make or end an offer', async () => {
    expect((await api.get('/v1/admin/coupons')).status).toBe(401);
    expect((await api.get('/v1/admin/coupons').set(USER)).status).toBe(403);
    expect((await api.post('/v1/admin/coupons').set(USER).send(offer())).status).toBe(403);
    expect((await api.post('/v1/admin/coupons/abc/end').set(USER)).status).toBe(403);
    expect(await db.listCoupons()).toHaveLength(0);
    expect(dodo).toHaveLength(0);
  });
});

describe('making an offer (admin)', () => {
  it('creates the discount in Dodo first, for the first payment only, then keeps the offer', async () => {
    const starts = inHours(-1);
    const ends = inHours(48);
    const res = await make({ code: 'launch20', startsAt: starts, endsAt: ends });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: 'LAUNCH20', title: 'Launch offer', percentOff: 20, status: 'live' });
    expect(JSON.stringify(res.body)).not.toMatch(/dsc_1|sk_test/);

    const call = dodo.find((c) => c.method === 'POST' && c.url.endsWith('/discounts'))!;
    expect(call.url).toBe('https://test.dodopayments.com/discounts');
    expect(call.body).toMatchObject({ type: 'percentage', amount: 2000, code: 'LAUNCH20', name: 'Launch offer', subscription_cycles: 1 });
    expect(call.body!.starts_at).toBe(starts);
    expect(call.body!.expires_at).toBe(ends);
    expect((await db.getCouponByCode('LAUNCH20'))?.dodoDiscountId).toBe('dsc_1');
  });

  it('starts now when no start is given, and an offer that starts later is "scheduled"', async () => {
    expect((await make()).body.status).toBe('live');
    const later = await make({ code: 'LATER10', startsAt: inHours(2), endsAt: inHours(10) });
    expect(later.body.status).toBe('scheduled');
  });

  it('refuses a bad code, name, percentage or time without calling Dodo', async () => {
    const bad: Record<string, unknown>[] = [
      { code: 'ab' },
      { code: 'has space' },
      { code: 'WAYTOOLONGCODE12345' },
      { title: 'x' },
      { percentOff: 0 },
      { percentOff: 91 },
      { percentOff: 12.5 },
      { endsAt: inHours(-1) },
      { startsAt: inHours(10), endsAt: inHours(5) },
      { endsAt: inHours(24 * 400) },
      { endsAt: 'tomorrow' },
    ];
    for (const over of bad) expect((await make(over)).status, JSON.stringify(over)).toBe(400);
    expect(dodo).toHaveLength(0);
    expect(await db.listCoupons()).toHaveLength(0);
  });

  it('refuses a code that is already used, with no second discount in Dodo', async () => {
    expect((await make()).status).toBe(201);
    const again = await make({ title: 'Another' });
    expect(again.status).toBe(409);
    expect(dodo.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('says calmly when Dodo is down and keeps nothing', async () => {
    stubDodo({ failDiscount: true });
    const res = await make();
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/sk_test/);
    expect(await db.listCoupons()).toHaveLength(0);
  });

  it('removes the Dodo discount again if it cannot be saved here', async () => {
    db.createCoupon = async () => {
      throw new Error('database down');
    };
    const res = await make();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(dodo.some((c) => c.method === 'DELETE' && c.url.endsWith('/discounts/dsc_1'))).toBe(true);
  });

  it('is closed when payments are not set up', async () => {
    const off = request(createApp(db, cfg));
    expect((await off.post('/v1/admin/coupons').set(ADMIN).send(offer())).status).toBe(503);
  });
});

describe('listing and ending offers (admin)', () => {
  it('lists every offer with where it stands', async () => {
    await make({ code: 'LIVEONE' });
    await make({ code: 'SOONONE', startsAt: inHours(3), endsAt: inHours(9) });
    await seed();
    const list = (await api.get('/v1/admin/coupons').set(ADMIN)).body.coupons as { code: string; status: string }[];
    expect(Object.fromEntries(list.map((c) => [c.code, c.status]))).toEqual({ LIVEONE: 'live', SOONONE: 'scheduled', OLDONE: 'ended' });
  });

  it('ends an offer now: the Dodo discount is removed first, and doing it twice is harmless', async () => {
    const id = (await make()).body.id as string;
    const res = await api.post(`/v1/admin/coupons/${id}/end`).set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ended');
    expect(dodo.filter((c) => c.method === 'DELETE')).toHaveLength(1);

    expect((await api.post(`/v1/admin/coupons/${id}/end`).set(ADMIN)).status).toBe(200);
    expect(dodo.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('keeps the offer on when Dodo cannot remove the discount, so the two never disagree', async () => {
    const id = (await make()).body.id as string;
    stubDodo({ failDelete: true });
    expect((await api.post(`/v1/admin/coupons/${id}/end`).set(ADMIN)).status).toBe(502);
    expect(couponStatus((await db.getCoupon(id))!, new Date())).toBe('live');
  });

  it('says so for an offer that does not exist', async () => {
    expect((await api.post('/v1/admin/coupons/nope/end').set(ADMIN)).status).toBe(404);
  });
});

describe('the offers people see', () => {
  it('needs a sign-in', async () => {
    expect((await api.get('/v1/billing/offers')).status).toBe(401);
  });

  it('shows only offers that are live now, and only what the card needs', async () => {
    await make({ code: 'LIVEONE', title: 'Live', percentOff: 25, endsAt: inHours(5) });
    await make({ code: 'SOONONE', startsAt: inHours(3), endsAt: inHours(9) });
    await seed(); // over
    const stopped = (await make({ code: 'STOPPED' })).body.id as string;
    await api.post(`/v1/admin/coupons/${stopped}/end`).set(ADMIN);

    const res = await api.get('/v1/billing/offers').set(USER);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.offers).toHaveLength(1);
    expect(Object.keys(res.body.offers[0]).sort()).toEqual(['code', 'endsAt', 'percentOff', 'title']);
    expect(res.body.offers[0]).toMatchObject({ code: 'LIVEONE', title: 'Live', percentOff: 25 });
  });

  it('shows nothing when no offer is on', async () => {
    expect((await api.get('/v1/billing/offers').set(USER)).body.offers).toEqual([]);
  });

  it('an offer disappears when its time is over', async () => {
    await seed({ code: 'ENDSOON', startsAt: inHours(-2), endsAt: new Date(Date.now() + 1500).toISOString() });
    expect((await api.get('/v1/billing/offers').set(USER)).body.offers).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1700));
    expect((await api.get('/v1/billing/offers').set(USER)).body.offers).toHaveLength(0);
  });
});

describe('paying with an offer', () => {
  const pay = (body: Record<string, unknown>) => api.post('/v1/billing/checkout-session').set(USER).send(body);
  const checkoutCall = () => dodo.find((c) => c.url.endsWith('/checkouts'));

  it('passes a live offer to the checkout as a discount code, typed in any case', async () => {
    await make();
    const res = await pay({ plan: 'yearly', coupon: 'launch20' });
    expect(res.status).toBe(201);
    expect(checkoutCall()!.body!.discount_codes).toEqual(['LAUNCH20']);
  });

  it('sends no discount code when none is chosen', async () => {
    await make();
    await pay({ plan: 'yearly' });
    expect(checkoutCall()!.body).not.toHaveProperty('discount_codes');
  });

  it('refuses an offer that is unknown, not started, over or ended, and starts no payment', async () => {
    await make({ code: 'SOONONE', startsAt: inHours(3), endsAt: inHours(9) });
    await seed({ code: 'OLDCODE' });
    const stopped = (await make({ code: 'STOPPED' })).body.id as string;
    await api.post(`/v1/admin/coupons/${stopped}/end`).set(ADMIN);
    for (const coupon of ['NOSUCH', 'SOONONE', 'OLDCODE', 'STOPPED']) {
      const res = await pay({ plan: 'yearly', coupon });
      expect(res.status, coupon).toBe(400);
      expect(res.body.error.message).toMatch(/not available/);
    }
    expect(checkoutCall()).toBeUndefined();
  });

  it('refuses a code that cannot be an offer code', async () => {
    expect((await pay({ plan: 'yearly', coupon: 'no way!' })).status).toBe(400);
    expect(checkoutCall()).toBeUndefined();
  });

  it('still refuses someone who already has a paid plan, offer or not', async () => {
    await make();
    await db.upsertSubscription({
      userId: 'dev-dave',
      status: 'active',
      intervalMonths: 1,
      dodoSubscriptionId: 'sub_1',
      dodoCustomerId: 'cus_1',
      currentPeriodEnd: inHours(24 * 20),
      lastEventAt: new Date().toISOString(),
    });
    expect((await pay({ plan: 'yearly', coupon: 'LAUNCH20' })).status).toBe(409);
    expect(checkoutCall()).toBeUndefined();
  });
});

describe('FR-BIL-12 an offer on the phone-to-website ticket', () => {
  const ticketCode = async (body: Record<string, unknown>) => {
    const res = await api.post('/v1/billing/ticket').set(USER).send(body);
    return { res, coupon: res.status === 201 ? new URL(res.body.url).searchParams.get('coupon') : null };
  };

  it('puts a live code in the link and sends it on to Dodo at checkout', async () => {
    await make();
    const { coupon, res } = await ticketCode({ plan: 'yearly', coupon: 'launch20' });
    expect(coupon).toBe('LAUNCH20');
    const token = new URL(res.body.url).searchParams.get('t')!;
    const pay = await api.post('/v1/billing/checkout').send({ ticket: token, coupon });
    expect(pay.status).toBe(201);
    const checkout = dodo.find((c) => c.url.endsWith('/checkouts'))!;
    expect(checkout.body?.discount_codes).toEqual(['LAUNCH20']);
  });

  it('refuses a code that is not live, at the ticket and at checkout', async () => {
    await seed();
    expect((await ticketCode({ coupon: 'OLDONE' })).res.status).toBe(400);
    const token = new URL((await ticketCode({})).res.body.url).searchParams.get('t')!;
    expect((await api.post('/v1/billing/checkout').send({ ticket: token, coupon: 'NOPE123' })).status).toBe(400);
  });
});
