import type { Coupon } from '../types.js';

export type CouponStatus = 'scheduled' | 'live' | 'ended';

/** Where an offer stands now: not started yet, on, or over (its time ran out, or an admin ended it early). */
export function couponStatus(c: Pick<Coupon, 'startsAt' | 'endsAt' | 'active'>, now: Date): CouponStatus {
  if (!c.active) return 'ended';
  const t = now.getTime();
  if (t < Date.parse(c.startsAt)) return 'scheduled';
  if (t >= Date.parse(c.endsAt)) return 'ended';
  return 'live';
}

export const isLive = (c: Pick<Coupon, 'startsAt' | 'endsAt' | 'active'>, now: Date): boolean => couponStatus(c, now) === 'live';

/** The longest an offer may run. */
export const MAX_COUPON_DAYS = 366;

/** What the admin screen sees of an offer. */
export function couponView(c: Coupon, now: Date) {
  return {
    id: c.id,
    code: c.code,
    title: c.title,
    percentOff: c.percentOff,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    status: couponStatus(c, now),
    createdAt: c.createdAt,
  };
}
