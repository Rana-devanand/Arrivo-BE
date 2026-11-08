import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import {
  FAMILY_KEY,
  FAMILY_MEMBERS,
  LIMITS,
  PLAN_MONTHS,
  PLAN_NAMES,
  PLAN_TAGLINES,
  PLUS_KEYS,
  PRICES_USD_CENTS,
  planDetails,
  planFeatures,
  hasPlus,
} from '../domain/plans.js';
import type { Db } from '../db/types.js';
import { COUNTRIES } from '../domain/countries.js';
import { isLive } from '../domain/coupons.js';
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
import type { AuthUser } from '../types.js';

const planKey = z.enum(['monthly', 'sixMonths', 'yearly', 'familyYearly']);
const planSchema = z.object({ plan: planKey.default('yearly') });
/** An offer code: what an admin made (3 to 16 capital letters and digits), typed in any case. */
const couponCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{3,16}$/, 'That offer code does not look right.');
const checkoutSessionSchema = planSchema.extend({ coupon: couponCode.optional() });
const checkoutSchema = z.object({
  ticket: z.string().min(20).max(100),
  plan: planKey.optional(),
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

  /** Whether this person may start paying for [plan] now. Returns the email the payment is made with. */
  async function assertCanSubscribe(user: AuthUser, plan: z.infer<typeof planKey>): Promise<string> {
    if (!billing) throw notSetUp();
    if (!user.email) throw badRequest('Your account has no email address. Add one to subscribe.');
    if (plan === FAMILY_KEY && !billing.products.familyYearly) {
      throw new AppError(503, 'billing_unavailable', 'Arrivo Plus Family is not open yet. Please check back soon.');
    }
    const current = await db.getSubscription(user.id);
    if (current?.status === 'active' && hasPlus(current)) {
      throw conflict('You already have a paid plan. Use "Manage subscription" to change it.');
    }
    return user.email;
  }

  /** Opens a Dodo checkout for this person and plan, and returns where they pay. */
  async function startCheckout(userId: string, email: string, plan: z.infer<typeof planKey>, discountCode?: string): Promise<string> {
    if (!billing) throw notSetUp();
    const name = (await db.getDisplayName(userId)) || undefined;
    const session = await createCheckoutSession(billing, { planKey: plan, email, name, userId, discountCode });
    await db.recordCheckout({ userId, email, planKey: plan, sessionId: session.sessionId });
    return session.checkoutUrl;
  }

  /** The plans and what they cost, for the app and the website. Public. */
  r.get('/billing/plans', (_req, res) => {
    const monthly = PRICES_USD_CENTS.monthly;
    res.json({
      currency: 'USD',
      available: billing !== null,
      plans: PLUS_KEYS.map((key) => {
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
      family: {
        key: FAMILY_KEY,
        name: PLAN_NAMES.family,
        tagline: PLAN_TAGLINES.family,
        features: planFeatures('family'),
        months: PLAN_MONTHS[FAMILY_KEY],
        priceCents: PRICES_USD_CENTS[FAMILY_KEY],
        members: FAMILY_MEMBERS,
        available: !!billing?.products.familyYearly,
        ...LIMITS.family,
      },
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
    const { plan, sub, via } = await planDetails(db, user.id);
    const used = (await db.listContacts(user.id)).length;
    // Plus through someone's Family: their plan's dates, not the member's own.
    const paid = via ? via.ownerSub : sub;
    const owner = via ? (await db.getDisplayName(via.ownerId)) || 'Your family' : null;
    res.json({
      plan,
      name: PLAN_NAMES[plan],
      planKey: paid?.planKey ?? null,
      status: paid?.status ?? null,
      intervalMonths: paid?.intervalMonths ?? null,
      // Paid time runs to this date; after a cancellation it is the last day of Plus.
      renewsAt: paid?.currentPeriodEnd ?? null,
      cancelled: paid?.status === 'cancelled' && hasPlus(paid),
      limits: LIMITS[plan],
      contactsUsed: used,
      // Only the person who pays can manage it.
      canManage: !via && !!sub?.dodoCustomerId,
      familyMemberOf: via ? { ownerName: owner } : null,
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
      const email = await assertCanSubscribe(user, plan);
      const now = Date.now();
      await db.deleteExpiredBillingTickets(new Date(now).toISOString());
      const { token, hash } = newTicketToken();
      await db.createBillingTicket({
        tokenHash: hash,
        userId: user.id,
        email,
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
      res.status(201).json({ checkoutUrl: await startCheckout(ticket.userId, ticket.email, planKey) });
    },
  );

  /**
   * The same checkout for someone signed in on the website (the account dashboard), with no ticket:
   * the Bearer token says who is paying. Only for the caller's own account, and never for someone
   * who already has a paid plan.
   */
  r.post(
    '/billing/checkout-session',
    rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false }),
    auth,
    async (req, res) => {
      const user = userOf(req);
      const { plan, coupon } = parse(checkoutSessionSchema, req.body ?? {});
      const email = await assertCanSubscribe(user, plan);
      // An offer only counts while it is live: checked here, and again by Dodo, which takes the money off.
      let discountCode: string | undefined;
      if (coupon) {
        const offer = await db.getCouponByCode(coupon);
        if (!offer || !isLive(offer, new Date())) throw badRequest('This offer is not available any more.');
        discountCode = offer.code;
      }
      res.status(201).json({ checkoutUrl: await startCheckout(user.id, email, plan, discountCode) });
    },
  );

  /** The offers that are on right now, for signed-in people: the ones whose time has come and not gone. */
  r.get('/billing/offers', auth, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const now = new Date();
    const live = (await db.listCoupons()).filter((c) => isLive(c, now));
    res.json({ offers: live.map((c) => ({ code: c.code, title: c.title, percentOff: c.percentOff, endsAt: c.endsAt })) });
  });

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
