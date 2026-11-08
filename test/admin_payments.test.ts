import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { MemoryDb } from '../src/db/memoryDb.js';
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

let db: MemoryDb;
let calls: string[];

const payment = (n: number, over: Record<string, unknown> = {}) => ({
  payment_id: `pay_${n}`,
  total_amount: 999,
  currency: 'USD',
  status: 'succeeded',
  created_at: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
  customer: { customer_id: 'cus_secret', name: 'Dave Kumar', email: 'dave@example.com' },
  subscription_id: 'sub_1',
  payment_method_type: 'credit',
  card_last_four: '4242',
  invoice_url: 'https://invoice.dodo.test/secret',
  charge_type: 'new',
  refund_status: null,
  dispute_status: null,
  ...over,
});

/** Stands in for Dodo's payment list, 100 to a page. */
function stubDodo(all: Record<string, unknown>[], fail = false) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (fail) return new Response('{}', { status: 500 });
      const page = Number(new URL(url).searchParams.get('page_number') ?? '0');
      return new Response(JSON.stringify({ items: all.slice(page * 100, page * 100 + 100) }), { status: 200 });
    }),
  );
}

async function appWith(billingCfg: BillingConfig | undefined) {
  const api = request(createApp(db, cfg, undefined, undefined, undefined, undefined, billingCfg));
  const me = await api.get('/v1/me').set(ADMIN);
  db.profiles.get(me.body.id)!.role = 'ADMIN';
  return api;
}

beforeEach(() => {
  db = new MemoryDb();
});
afterEach(() => vi.unstubAllGlobals());

describe('GET /v1/admin/payments (FR-BIL-13)', () => {
  it('needs a sign-in and an admin', async () => {
    stubDodo([payment(1)]);
    const api = await appWith(billing);
    expect((await api.get('/v1/admin/payments')).status).toBe(401);
    expect((await api.get('/v1/admin/payments').set(USER)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('lists the newest payments with only the fields the screen shows', async () => {
    stubDodo([payment(1), payment(3, { status: 'failed' }), payment(2, { refund_status: 'full', total_amount: 4900, charge_type: 'renewal' })]);
    const api = await appWith(billing);
    const res = await api.get('/v1/admin/payments').set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.truncated).toBe(false);
    expect(res.body.payments.map((p: { id: string }) => p.id)).toEqual(['pay_3', 'pay_2', 'pay_1']);
    expect(res.body.payments[1]).toMatchObject({
      amountMinor: 4900,
      currency: 'USD',
      status: 'succeeded',
      customerName: 'Dave Kumar',
      customerEmail: 'dave@example.com',
      chargeType: 'renewal',
      method: 'credit',
      refundStatus: 'full',
    });
    expect(calls[0]).toBe('https://test.dodopayments.com/payments?page_size=100&page_number=0');
    expect(JSON.stringify(res.body)).not.toMatch(/4242|cus_secret|invoice|sub_1|sk_test/);
  });

  it('reads on while a page is full, and says when there may be more', async () => {
    stubDodo(Array.from({ length: 520 }, (_, i) => payment(i)));
    const api = await appWith(billing);
    const res = await api.get('/v1/admin/payments').set(ADMIN);
    expect(res.body.payments).toHaveLength(500);
    expect(res.body.truncated).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it('skips items that do not look like a payment', async () => {
    stubDodo([payment(1), { payment_id: 'pay_bad' }, { ...payment(2), total_amount: 'free' }]);
    const api = await appWith(billing);
    const res = await api.get('/v1/admin/payments').set(ADMIN);
    expect(res.body.payments.map((p: { id: string }) => p.id)).toEqual(['pay_1']);
  });

  it('answers 503 when payments are not set up, and a calm 502 when Dodo is down', async () => {
    stubDodo([]);
    const off = await appWith(undefined);
    expect((await off.get('/v1/admin/payments').set(ADMIN)).status).toBe(503);

    db = new MemoryDb();
    stubDodo([], true);
    const api = await appWith(billing);
    const res = await api.get('/v1/admin/payments').set(ADMIN);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/sk_test/);
  });
});

describe('notifications with an attachment (admin)', () => {
  it('says a ride photo came with it, and never sends the photo', async () => {
    const api = await appWith(billing);
    const root = await api.get('/v1/me').set(ADMIN);
    await db.createNotification(root.body.id, { type: 'attachment', title: 'Ride photo shared', body: 'Dave shared the number plate', data: { photoUrl: 'https://img.test/secret.jpg' } });
    await db.createNotification(root.body.id, { type: 'journey_started', title: 'Started', body: 'Dave started' });
    const res = await api.get('/v1/admin/notifications').set(ADMIN);
    const byType = Object.fromEntries(res.body.notifications.map((n: { type: string; hasAttachment: boolean }) => [n.type, n.hasAttachment]));
    expect(byType.attachment).toBe(true);
    expect(byType.journey_started).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/secret\.jpg/);
  });
});
