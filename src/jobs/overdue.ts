import type { Db } from '../db/types.js';

/**
 * Moves journeys past expected arrival + grace period to "overdue" (SRS 5.6,
 * step 2). Runs on the server so it works when the phone is off. Alerting
 * contacts is added with the notification service.
 */
export function startOverdueJob(db: Db, intervalMs = 60_000): () => void {
  const tick = async () => {
    try {
      const n = await db.markOverdue(new Date().toISOString());
      if (n > 0) console.log(`[overdue] ${n} journey(s) marked overdue`);
    } catch (e) {
      console.error('[overdue] sweep failed:', e instanceof Error ? e.message : 'unknown error');
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(timer);
}
