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
  /** The Dodo product id of each way of paying for Arrivo Plus. */
  products: Record<PlanKey, string>;
  /** The Arrivo website, without a trailing slash: where people go to pay. */
  siteUrl: string;
}

const base = (mode: BillingConfig['mode']) =>
  mode === 'live' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';

const unavailable = () => new AppError(502, 'billing_unavailable', 'Payments are not available right now. Try again in a moment.');

async function call(cfg: BillingConfig, path: string, init: RequestInit): Promise<Record<string, unknown>> {
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
  if (!res.ok) {
    // Only the status: the body can echo the customer's email.
    logError(`[billing] Dodo ${init.method ?? 'GET'} ${path.split('?')[0]} returned ${res.status}`);
    throw unavailable();
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Starts a hosted checkout for one product. Each link is single-use and lasts 24 hours. */
export async function createCheckoutSession(
  cfg: BillingConfig,
  args: { planKey: PlanKey; email: string; name?: string; userId: string },
): Promise<{ sessionId: string | null; checkoutUrl: string }> {
  const out = await call(cfg, '/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      product_cart: [{ product_id: cfg.products[args.planKey], quantity: 1 }],
      customer: { email: args.email, ...(args.name ? { name: args.name } : {}) },
      return_url: `${cfg.siteUrl}/pricing/success`,
      cancel_url: `${cfg.siteUrl}/pricing/cancelled`,
      metadata: { user_id: args.userId, plan: args.planKey },
    }),
  });
  const url = out.checkout_url;
  if (typeof url !== 'string' || !url) throw unavailable();
  return { sessionId: typeof out.session_id === 'string' ? out.session_id : null, checkoutUrl: url };
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
