import type { Db } from '../db/types.js';
import type { PlanKey, Subscription } from '../types.js';

/** Arrivo Free, Arrivo Plus, and Arrivo Plus Family (Plus shared with 2 members). */
export type PlanId = 'free' | 'plus' | 'family';

export interface PlanLimits {
  /** How many trusted contacts someone can have (not counting removed ones). */
  contacts: number;
  /** Whether they can create a Family circle. */
  household: boolean;
}

export const LIMITS: Record<PlanId, PlanLimits> = {
  free: { contacts: 1, household: false },
  plus: { contacts: 10, household: true },
  family: { contacts: 10, household: true },
};

/** How many people the owner of Arrivo Plus Family can share it with. */
export const FAMILY_MEMBERS = 2;

export const PLAN_NAMES: Record<PlanId, string> = {
  free: 'Arrivo Free',
  plus: 'Arrivo Plus',
  family: 'Arrivo Plus Family',
};

export const PLAN_TAGLINES: Record<PlanId, string> = {
  free: 'Everything you need to start.',
  plus: 'For families and anyone who travels a lot.',
  family: `Arrivo Plus for you and ${FAMILY_MEMBERS} people you choose, for a year.`,
};

const contactsText = (n: number) => `${n} trusted contact${n === 1 ? '' : 's'}`;

/** What each plan includes, worded from the limits so the lists never disagree with what is enforced. */
export function planFeatures(id: PlanId): string[] {
  const l = LIMITS[id];
  if (id === 'free') {
    return [
      'Live location sharing during a journey',
      contactsText(l.contacts),
      'Arrival and running-late alerts',
      'Safety timer and watch link',
      'Journey history and battery report',
    ];
  }
  if (id === 'family') {
    return [
      'Everything in Arrivo Plus, for you',
      `Arrivo Plus for ${FAMILY_MEMBERS} more people you invite by email`,
      'Each member uses their own Arrivo account',
      'Paid once a year',
    ];
  }
  return [
    'Everything in Arrivo Free',
    `Up to ${contactsText(l.contacts)}`,
    'Family circle: add a whole family to a journey in one tap',
  ];
}

/** Months in each way of paying. */
export const PLAN_MONTHS: Record<PlanKey, 1 | 6 | 12> = { monthly: 1, sixMonths: 6, yearly: 12, familyYearly: 12 };

/** The ways of paying for Arrivo Plus itself (Family has its own single price). */
export const PLUS_KEYS = ['monthly', 'sixMonths', 'yearly'] as const satisfies readonly PlanKey[];
export const FAMILY_KEY = 'familyYearly' as const satisfies PlanKey;

/**
 * What people pay, in US cents, tax inclusive. The amount actually charged is the price of the
 * product in the Dodo dashboard (in USD): keep them equal, and equal to the website's
 * `src/config/pricing.ts`. Local prices are these converted at the day's rate, only an estimate.
 */
export const PRICES_USD_CENTS: Record<PlanKey, number> = {
  monthly: 299,
  sixMonths: 1499,
  yearly: 2499,
  familyYearly: 4900,
};

/** A renewal that is late by less than this is treated as still paid (webhooks can arrive late). */
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Whether a subscription still gives Arrivo Plus right now:
 *  - active, or in the grace period after a failed renewal (past_due): yes, until the period ends
 *  - cancelled: yes until the time already paid for ends
 *  - on hold, expired, failed: no
 */
export function hasPlus(sub: Subscription | null, now = Date.now()): boolean {
  if (!sub) return false;
  const end = sub.currentPeriodEnd ? Date.parse(sub.currentPeriodEnd) : null;
  switch (sub.status) {
    case 'active':
    case 'past_due':
      return end === null || now < end + GRACE_MS;
    case 'cancelled':
      return end !== null && now < end;
    default:
      return false;
  }
}

export const isFamilySub = (sub: Subscription | null): boolean => sub?.planKey === FAMILY_KEY;

/** Where someone's plan comes from. */
export interface PlanDetails {
  plan: PlanId;
  /** Their own subscription, if any. */
  sub: Subscription | null;
  /** Set when Plus comes from someone else's Arrivo Plus Family. */
  via: { ownerId: string; ownerSub: Subscription } | null;
}

/**
 * The plan someone is on: their own paid plan first, else Plus through an Arrivo Plus
 * Family they accepted, as long as the owner's plan is still paid.
 */
export async function planDetails(db: Db, userId: string, now = Date.now()): Promise<PlanDetails> {
  const sub = await db.getSubscription(userId);
  if (hasPlus(sub, now)) return { plan: isFamilySub(sub) ? 'family' : 'plus', sub, via: null };
  const membership = await db.getFamilyMembershipOf(userId);
  if (membership) {
    const ownerSub = await db.getSubscription(membership.ownerId);
    if (hasPlus(ownerSub, now) && isFamilySub(ownerSub) && ownerSub) {
      return { plan: 'plus', sub, via: { ownerId: membership.ownerId, ownerSub } };
    }
  }
  return { plan: 'free', sub, via: null };
}

export async function planOf(db: Db, userId: string, now = Date.now()): Promise<PlanId> {
  return (await planDetails(db, userId, now)).plan;
}

export const intervalMonthsOf = (key: PlanKey): 1 | 6 | 12 => PLAN_MONTHS[key];
