import type { Db } from '../db/types.js';
import type { PlanKey, Subscription } from '../types.js';

/** Arrivo Free and Arrivo Plus. */
export type PlanId = 'free' | 'plus';

export interface PlanLimits {
  /** How many trusted contacts someone can have (not counting removed ones). */
  contacts: number;
  /** Whether they can create a Family household. */
  household: boolean;
}

export const LIMITS: Record<PlanId, PlanLimits> = {
  free: { contacts: 1, household: false },
  plus: { contacts: 10, household: true },
};

export const PLAN_NAMES: Record<PlanId, string> = { free: 'Arrivo Free', plus: 'Arrivo Plus' };

export const PLAN_TAGLINES: Record<PlanId, string> = {
  free: 'Everything you need to start.',
  plus: 'For families and anyone who travels a lot.',
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
  return [
    'Everything in Arrivo Free',
    `Up to ${contactsText(l.contacts)}`,
    'Family household: add a whole family to a journey in one tap',
  ];
}

/** Months in each way of paying. */
export const PLAN_MONTHS: Record<PlanKey, 1 | 6 | 12> = { monthly: 1, sixMonths: 6, yearly: 12 };

export const PLAN_KEYS = Object.keys(PLAN_MONTHS) as PlanKey[];

/**
 * What people pay, in US cents, tax inclusive. The amount actually charged is the price of the
 * product in the Dodo dashboard (in USD): keep them equal. Local prices shown in the app and on the
 * website are these converted at the day's exchange rate, and are only an estimate.
 */
export const PRICES_USD_CENTS: Record<PlanKey, number> = { monthly: 299, sixMonths: 1499, yearly: 2499 };

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

export async function planOf(db: Db, userId: string, now = Date.now()): Promise<PlanId> {
  return hasPlus(await db.getSubscription(userId), now) ? 'plus' : 'free';
}

export const intervalMonthsOf = (key: PlanKey): 1 | 6 | 12 => PLAN_MONTHS[key];
