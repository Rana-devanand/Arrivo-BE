import type { JourneyStatus } from '../types.js';

/** Journey states where location is shared (SRS 5.2). */
export const OPEN_STATUSES: JourneyStatus[] = ['active', 'overdue'];
export const FINAL_STATUSES: JourneyStatus[] = ['completed', 'cancelled'];

export const isOpen = (s: JourneyStatus) => OPEN_STATUSES.includes(s);
export const isFinal = (s: JourneyStatus) => FINAL_STATUSES.includes(s);

/** Watch links keep working this long after a journey ends (SRS FR-CON-07). */
export const WATCH_GRACE_MS = 2 * 60 * 60 * 1000;

/** Expected arrival must be in the near future, and not absurdly far. */
export function validateArrival(iso: string, now = Date.now()): string | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'Arrival time is not a valid date';
  if (t < now - 60_000) return 'Arrival time must be in the future';
  if (t > now + 48 * 60 * 60 * 1000) return 'Arrival time cannot be more than 48 hours away';
  return null;
}
