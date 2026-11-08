import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { PLAN_MONTHS } from '../domain/plans.js';
import type { PlanKey } from '../types.js';
import { AppError } from './errors.js';
import { logError } from './log.js';

/**
 * Dodo Payments. People pay on the Arrivo website, never inside the app. This talks
 * to Dodo from the server only: the API key never reaches the app or the website.
 * Docs: https://docs.dodopayments.com
 */
export interface BillingConfig {
  apiKey: string;
  /** Test keys only work against the test address, live keys against the live one. */
  mode: 'test' | 'live';
  /** The signing secret of the webhook ("whsec_..."). */
  webhookSecret: string;
  /**
   * The Dodo product id of each way of paying for Arrivo Plus, and of Arrivo Plus Family
   * when that product is set up (until then Family says "not open yet").
   */
  products: Record<Exclude<PlanKey, 'familyYearly'>, string> & { familyYearly?: string };
  /** The Arrivo website, without a trailing slash: where people go to pay. */
  siteUrl: string;
}

const base = (mode: BillingConfig['mode']) =>
  mode === 'live' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';

const unavailable = () => new AppError(502, 'billing_unavailable', 'Payments are not available right now. Try again in a moment.');

/** [tolerate] lists statuses that count as success (a delete of something already gone). */
async function call(cfg: BillingConfig, path: string, init: RequestInit, tolerate: number[] = []): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${base(cfg.mode)}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw unavailable();
  }
  if (tolerate.includes(res.status) || res.status === 204) return {};
  if (!res.ok) {
    // The status and Dodo's short error code only: the body can echo the customer's email.
    const code = await res
      .json()
      .then((b: { code?: unknown }) => (typeof b?.code === 'string' ? b.code.slice(0, 60) : ''))
      .catch(() => '');
    logError(`[billing] Dodo ${init.method ?? 'GET'} ${path.split('?')[0]} (${cfg.mode} mode) returned ${res.status}${code ? ` ${code}` : ''}`);
    throw unavailable();
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Starts a hosted checkout for one product. Each link is single-use and lasts 24 hours. */
export async function createCheckoutSession(
  cfg: BillingConfig,
  args: { planKey: PlanKey; email: string; name?: string; userId: string; discountCode?: string },
): Promise<{ sessionId: string | null; checkoutUrl: string }> {
  const product = cfg.products[args.planKey];
  if (!product) throw new AppError(503, 'billing_unavailable', 'This plan is not open yet. Please check back soon.');
  const out = await call(cfg, '/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      product_cart: [{ product_id: product, quantity: 1 }],
      customer: { email: args.email, ...(args.name ? { name: args.name } : {}) },
      return_url: `${cfg.siteUrl}/pricing/success`,
      cancel_url: `${cfg.siteUrl}/pricing/cancelled`,
      metadata: { user_id: args.userId, plan: args.planKey },
      // An offer the person chose. Dodo checks it (time window, validity) and takes the percentage off.
      ...(args.discountCode ? { discount_codes: [args.discountCode] } : {}),
    }),
  });
  const url = out.checkout_url;
  if (typeof url !== 'string' || !url) throw unavailable();
  return { sessionId: typeof out.session_id === 'string' ? out.session_id : null, checkoutUrl: url };
}

/**
 * Makes the discount in Dodo that an offer stands for: a percentage off the FIRST payment only (without
 * `subscription_cycles` a subscription would keep the discount on every renewal), valid between the two times.
 * Dodo counts the percentage in basis points: 20% is 2000. Returns Dodo's id for it.
 */
export async function createDiscount(
  cfg: BillingConfig,
  args: { code: string; name: string; percentOff: number; startsAt: string; endsAt: string },
): Promise<string> {
  const out = await call(cfg, '/discounts', {
    method: 'POST',
    body: JSON.stringify({
      type: 'percentage',
      amount: args.percentOff * 100,
      code: args.code,
      name: args.name,
      starts_at: args.startsAt,
      expires_at: args.endsAt,
      subscription_cycles: 1,
    }),
  });
  const id = out.discount_id;
  if (typeof id !== 'string' || !id) throw unavailable();
  return id;
}

/** Removes the discount in Dodo, so the code stops working there too. Already gone counts as done. */
export async function deleteDiscount(cfg: BillingConfig, discountId: string): Promise<void> {
  await call(cfg, `/discounts/${encodeURIComponent(discountId)}`, { method: 'DELETE' }, [404]);
}

/** One payment as the admin Revenue screen needs it. No card details, invoice links or customer ids. */
export interface PaymentRecord {
  id: string;
  /** In the smallest unit of `currency` (cents for USD), as Dodo counts it. */
  amountMinor: number;
  currency: string;
  status: string;
  createdAt: string;
  customerName: string;
  customerEmail: string;
  /** new, renewal, plan_change or on_demand when Dodo says. */
  chargeType: string | null;
  method: string | null;
  refundStatus: 'partial' | 'full' | null;
  disputeStatus: string | null;
}

const PAYMENT_PAGE = 100;
/** Pages read per request (500 payments): Dodo has no total, so this bounds the work. */
const PAYMENT_PAGES = 5;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * The newest payments, read from Dodo itself (the source of truth for money), up to 500. `truncated` is true
 * when there may be more. Items that do not look like a payment are skipped rather than guessed at.
 */
export async function listPayments(cfg: BillingConfig): Promise<{ payments: PaymentRecord[]; truncated: boolean }> {
  const payments: PaymentRecord[] = [];
  let truncated = false;
  for (let page = 0; page < PAYMENT_PAGES; page++) {
    const out = await call(cfg, `/payments?${new URLSearchParams({ page_size: String(PAYMENT_PAGE), page_number: String(page) })}`, { method: 'GET' });
    const items = Array.isArray(out.items) ? (out.items as Record<string, unknown>[]) : [];
    for (const p of items) {
      const id = str(p.payment_id);
      const createdAt = str(p.created_at);
      if (!id || !createdAt || typeof p.total_amount !== 'number' || !Number.isFinite(p.total_amount)) continue;
      const customer = (typeof p.customer === 'object' && p.customer !== null ? p.customer : {}) as Record<string, unknown>;
      const refund = p.refund_status === 'partial' || p.refund_status === 'full' ? p.refund_status : null;
      payments.push({
        id,
        amountMinor: Math.round(p.total_amount),
        currency: (str(p.currency) ?? 'USD').toUpperCase(),
        status: str(p.status) ?? 'unknown',
        createdAt,
        customerName: str(customer.name) ?? '',
        customerEmail: str(customer.email) ?? '',
        chargeType: str(p.charge_type),
        method: str(p.payment_method_type) ?? str(p.payment_method),
        refundStatus: refund,
        disputeStatus: str(p.dispute_status),
      });
    }
    if (items.length < PAYMENT_PAGE) break;
    if (page === PAYMENT_PAGES - 1) truncated = true;
  }
  payments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return { payments, truncated };
}

/** A link to Dodo's customer portal, where the customer can cancel, change card, see invoices. */
export async function createPortalLink(cfg: BillingConfig, customerId: string, returnUrl: string): Promise<string> {
  const qs = new URLSearchParams({ return_url: returnUrl });
  const out = await call(cfg, `/customers/${encodeURIComponent(customerId)}/customer-portal/session?${qs}`, { method: 'POST' });
  if (typeof out.link !== 'string' || !out.link) throw unavailable();
  return out.link;
}

/** Five minutes either way, as the Standard Webhooks libraries allow. */
const TOLERANCE_SECONDS = 300;

/**
 * Checks that a webhook really came from Dodo (Standard Webhooks): an HMAC-SHA256 of
 * "id.timestamp.body" with the secret, compared in constant time, and a recent timestamp.
 * [rawBody] must be the bytes as received, not re-serialised JSON.
 */
export function verifyWebhook(
  rawBody: Buffer | string,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret: string,
  nowMs = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();

  // The header can hold several signatures: "v1,abc v1,def".
  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

/** A random one-time token, and the hash we store in its place. */
export function newTicketToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashTicket(token) };
}

export const hashTicket = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Months a Dodo product pays for, to tell which way of paying a customer chose. */
export function planKeyOfProduct(cfg: BillingConfig, productId: string | undefined): PlanKey | null {
  if (!productId) return null;
  return (Object.keys(PLAN_MONTHS) as PlanKey[]).find((k) => cfg.products[k] === productId) ?? null;
}
