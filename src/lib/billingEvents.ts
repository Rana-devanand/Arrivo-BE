import { PLAN_MONTHS } from '../domain/plans.js';
import type { Db } from '../db/types.js';
import type { PlanKey, Subscription, SubscriptionStatus } from '../types.js';
import { planKeyOfProduct, type BillingConfig } from './dodo.js';
import { logInfo } from './log.js';

export interface DodoEvent {
  type?: string;
  timestamp?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: Record<string, any>;
}

/** What Dodo calls a subscription's state, as ours. Paused gives no access, like on hold. */
function statusOf(dodo: unknown): SubscriptionStatus | null {
  switch (dodo) {
    case 'active':
      return 'active';
    case 'on_hold':
    case 'paused':
      return 'on_hold';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

/** The state each event leads to. */
function statusForEvent(type: string, data: Record<string, unknown>): SubscriptionStatus | null {
  switch (type) {
    case 'subscription.active':
    case 'subscription.renewed':
    case 'subscription.plan_changed':
    case 'subscription.unpaused':
      return 'active';
    case 'subscription.updated':
      return statusOf(data.status);
    case 'subscription.past_due':
      return 'past_due';
    case 'subscription.on_hold':
      return 'on_hold';
    case 'subscription.cancelled':
      return 'cancelled';
    case 'subscription.expired':
      return 'expired';
    case 'subscription.failed':
      return 'failed';
    default:
      return null;
  }
}

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** How far back a checkout started with the same email still counts as "this payment". */
const CHECKOUT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export type EventResult = 'applied' | 'ignored' | 'stale' | 'unmatched';

/**
 * Updates someone's subscription from a Dodo webhook. Safe to run twice (Dodo retries):
 * an event older than the newest one already applied changes nothing.
 *
 * Who it belongs to, in order: our own `user_id` in the metadata, a subscription we
 * already know by its Dodo id, the newest checkout started with that email.
 */
export async function applyDodoEvent(db: Db, cfg: BillingConfig, event: DodoEvent, nowMs = Date.now()): Promise<EventResult> {
  const type = event.type ?? '';
  const data = event.data ?? {};
  if (!type.startsWith('subscription.')) return 'ignored';

  const dodoId = typeof data.subscription_id === 'string' ? data.subscription_id : null;
  const customerId = typeof data.customer?.customer_id === 'string' ? (data.customer.customer_id as string) : null;
  const email = typeof data.customer?.email === 'string' ? (data.customer.email as string) : null;
  const known = dodoId ? await db.getSubscriptionByDodoId(dodoId) : null;

  let userId: string | null =
    typeof data.metadata?.user_id === 'string' ? (data.metadata.user_id as string) : (known?.userId ?? null);
  let checkoutPlan: PlanKey | null = null;
  if (!userId && email) {
    const found = await db.findLatestCheckoutByEmail(email, new Date(nowMs - CHECKOUT_WINDOW_MS).toISOString());
    userId = found?.userId ?? null;
    checkoutPlan = found?.planKey ?? null;
  }
  if (!userId) {
    logInfo(`[billing] ${type} could not be tied to a person (subscription ${dodoId ?? 'unknown'})`);
    return 'unmatched';
  }

  const status = statusForEvent(type, data);
  if (!status) return 'ignored';

  const existing = known ?? (await db.getSubscription(userId));
  const eventAt = iso(event.timestamp) ?? new Date(nowMs).toISOString();
  if (existing && Date.parse(existing.lastEventAt) > Date.parse(eventAt)) return 'stale';

  const planKey =
    planKeyOfProduct(cfg, typeof data.product_id === 'string' ? data.product_id : undefined) ??
    (typeof data.metadata?.plan === 'string' && data.metadata.plan in PLAN_MONTHS ? (data.metadata.plan as PlanKey) : null) ??
    checkoutPlan;

  // A cancelled customer keeps what they paid for until the period ends: the end is never moved
  // forward by a cancellation. Every other event can carry a new next billing date.
  const nextBilling = iso(data.next_billing_date);
  const periodEnd = status === 'cancelled' ? (existing?.currentPeriodEnd ?? nextBilling) : (nextBilling ?? existing?.currentPeriodEnd ?? null);

  const next: Subscription = {
    userId,
    status,
    intervalMonths: planKey ? PLAN_MONTHS[planKey] : (existing?.intervalMonths ?? null),
    dodoSubscriptionId: dodoId ?? existing?.dodoSubscriptionId ?? null,
    dodoCustomerId: customerId ?? existing?.dodoCustomerId ?? null,
    currentPeriodEnd: periodEnd,
    lastEventAt: eventAt,
  };
  await db.upsertSubscription(next);
  logInfo(`[billing] ${type} applied status=${status} interval=${next.intervalMonths ?? '-'}`);
  return 'applied';
}
