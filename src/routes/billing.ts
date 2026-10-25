import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { LIMITS, PLAN_KEYS, PLAN_MONTHS, PLAN_NAMES, PLAN_TAGLINES, PRICES_USD_CENTS, planFeatures, hasPlus, planOf } from '../domain/plans.js';
import type { Db } from '../db/types.js';
import { COUNTRIES } from '../domain/countries.js';
import { applyDodoEvent, type DodoEvent } from '../lib/billingEvents.js';
import {
  createCheckoutSession,
  createPortalLink,
  hashTicket,
  newTicketToken,
  verifyWebhook,
  type BillingConfig,
} from '../lib/dodo.js';
import { AppError, badRequest, conflict, gone, notFound } from '../lib/errors.js';
import { logError } from '../lib/log.js';
import { createRatesProvider, type RatesProvider } from '../lib/rates.js';
import { requireAuth, userOf } from '../middleware/auth.js';
import { parse } from '../middleware/errors.js';

const planSchema = z.object({ plan: z.enum(['monthly', 'sixMonths', 'yearly']).default('yearly') });
const checkoutSchema = z.object({
  ticket: z.string().min(20).max(100),
  plan: z.enum(['monthly', 'sixMonths', 'yearly']).optional(),
});

/** A pass from the app to the website lasts this long. */
const TICKET_MINUTES = 30;

const notSetUp = () =>
  new AppError(503, 'billing_unavailable', 'Paid plans are not open yet. Please check back soon.');

/** The request body exactly as it arrived, kept by the JSON parser (see app.ts) for webhook signatures. */
export type WithRawBody = Request & { rawBody?: Buffer };

/**
 * Arrivo Plus. People pay on the Arrivo website through Dodo Payments, never in the app:
 *  1. the app asks for a ticket (POST /billing/ticket) and opens the website with it;
 *  2. the website turns the ticket into a Dodo checkout (POST /billing/checkout) and sends
 *     the person there to pay;
 *  3. Dodo tells us the result (POST /billing/webhook) and the plan switches on.
 */
export function billingRoutes(
  db: Db,
  billing: BillingConfig | null,
  rates: RatesProvider = createRatesProvider(),
): Router {
  const r = Router();
  const auth = requireAuth(db);

  /** The plans and what they cost, for the app and the website. Public. */
  r.get('/billing/plans', (_req, res) => {
    const monthly = PRICES_USD_CENTS.monthly;
    res.json({
      currency: 'USD',
      available: billing !== null,
      plans: PLAN_KEYS.map((key) => {
        const months = PLAN_MONTHS[key];
        const price = PRICES_USD_CENTS[key];
        return {
          key,
          months,
          priceCents: price,
          perMonthCents: Math.round(price / months),
          savePercent: Math.max(0, Math.round((1 - price / (months * monthly)) * 100)),
        };
      }),
      free: { name: PLAN_NAMES.free, tagline: PLAN_TAGLINES.free, features: planFeatures('free'), ...LIMITS.free },
      plus: { name: PLAN_NAMES.plus, tagline: PLAN_TAGLINES.plus, features: planFeatures('plus'), ...LIMITS.plus },
    });
  });

  /**
   * Exchange rates and the countries people can look prices up for. Public. Local prices are
   * estimates: people are charged in US dollars.
   */
  r.get('/billing/rates', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ ...(await rates()), countries: COUNTRIES });
  });

  /** Which plan this person is on, and its limits. */
  r.get('/billing/me', auth, async (req, res) => {
    const user = userOf(req);
    const sub = await db.getSubscription(user.id);
    const plan = await planOf(db, user.id);
    const used = (await db.listContacts(user.id)).length;
    res.json({
      plan,
      name: PLAN_NAMES[plan],
      status: sub?.status ?? null,
      intervalMonths: sub?.intervalMonths ?? null,
      // Paid time runs to this date; after a cancellation it is the last day of Plus.
      renewsAt: sub?.currentPeriodEnd ?? null,
      cancelled: sub?.status === 'cancelled' && hasPlus(sub),
      limits: LIMITS[plan],
      contactsUsed: used,
      canManage: !!sub?.dodoCustomerId,
    });
  });

  /**
   * Step 1: a pass to the website. Only a hash is stored; it works for 30 minutes and names
   * who is paying, so the website needs no sign-in and the address holds no password or token.
   */
  r.post(
    '/billing/ticket',
    rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }),
    auth,
    async (req, res) => {
      if (!billing) throw notSetUp();
      const user = userOf(req);
      const { plan } = parse(planSchema, req.body ?? {});
      if (!user.email) throw badRequest('Your account has no email address. Add one to subscribe.');
      const current = await db.getSubscription(user.id);
      if (current?.status === 'active' && hasPlus(current)) {
        throw conflict('You already have Arrivo Plus. Use "Manage subscription" to change it.');
      }
      const now = Date.now();
      await db.deleteExpiredBillingTickets(new Date(now).toISOString());
      const { token, hash } = newTicketToken();
      await db.createBillingTicket({
        tokenHash: hash,
        userId: user.id,
        email: user.email,
        planKey: plan,
        expiresAt: new Date(now + TICKET_MINUTES * 60_000).toISOString(),
      });
      res.status(201).json({ url: `${billing.siteUrl}/pricing?t=${token}&plan=${plan}`, expiresInMinutes: TICKET_MINUTES });
    },
  );

  /** Step 2 (called by the website): turn a ticket into a Dodo checkout and return where to pay. */
  r.post(
    '/billing/checkout',
    rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false }),
    async (req, res) => {
      if (!billing) throw notSetUp();
      const body = parse(checkoutSchema, req.body);
      const ticket = await db.getBillingTicket(hashTicket(body.ticket));
      if (!ticket || ticket.expiresAt < new Date().toISOString()) {
        throw gone('This link has expired. Open Arrivo and tap Upgrade again.');
      }
      const planKey = body.plan ?? ticket.planKey;
      const name = (await db.getDisplayName(ticket.userId)) || undefined;
      const session = await createCheckoutSession(billing, { planKey, email: ticket.email, name, userId: ticket.userId });
      await db.recordCheckout({ userId: ticket.userId, email: ticket.email, planKey, sessionId: session.sessionId });
      res.status(201).json({ checkoutUrl: session.checkoutUrl });
    },
  );

  /** A link to Dodo's customer portal: cancel, change card, invoices. */
  r.post('/billing/portal', auth, async (req, res) => {
    if (!billing) throw notSetUp();
    const sub = await db.getSubscription(userOf(req).id);
    if (!sub?.dodoCustomerId) throw notFound('You have no subscription to manage.');
    res.json({ url: await createPortalLink(billing, sub.dodoCustomerId, `${billing.siteUrl}/pricing/success`) });
  });

  /** Step 3: Dodo's report of what happened. Signed; anything unsigned is refused. */
  r.post('/billing/webhook', async (req, res) => {
    if (!billing) throw notSetUp();
    const raw = (req as WithRawBody).rawBody;
    const h = req.headers;
    const ok =
      !!raw &&
      verifyWebhook(
        raw,
        {
          id: h['webhook-id'] as string | undefined,
          timestamp: h['webhook-timestamp'] as string | undefined,
          signature: h['webhook-signature'] as string | undefined,
        },
        billing.webhookSecret,
      );
    if (!ok) {
      logError('[billing] webhook refused: bad or missing signature');
      throw new AppError(401, 'unauthorized', 'Invalid signature');
    }
    const result = await applyDodoEvent(db, billing, req.body as DodoEvent);
    // A 2xx tells Dodo not to retry. An event we cannot place is logged, not retried forever.
    res.status(200).json({ received: true, result });
  });

  return r;
}
