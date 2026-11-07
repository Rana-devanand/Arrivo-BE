import type { Db } from '../db/types.js';
import { errorText, logError } from './log.js';

const MEMORY_MS = 60 * 60_000;
const memory = new Map<string, { at: number; value: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

export interface Loaded<T> {
  value: T;
  /** False when some part of the lookup failed: the answer is shown but never stored. */
  complete: boolean;
}

/**
 * Looks in memory, then in the shared database cache, then runs [load]. A slow or
 * paid lookup therefore runs once per place, not once per request.
 *
 * Only complete answers are stored, so a failed sub-call never turns into a
 * month of missing data. Two requests for the same key at the same moment share
 * one lookup. A broken cache table never breaks the request: it just costs a lookup.
 */
export async function cached<T>(
  db: Db,
  key: string,
  ttlMs: number,
  load: () => Promise<Loaded<T> | null>,
): Promise<T | null> {
  const hot = memory.get(key);
  if (hot && Date.now() - hot.at <= Math.min(MEMORY_MS, ttlMs)) return hot.value as T;

  try {
    const stored = await db.getCache(key, ttlMs);
    if (stored !== null && stored !== undefined) {
      memory.set(key, { at: Date.now(), value: stored });
      return stored as T;
    }
  } catch (e) {
    logError(`[cache] read failed: ${errorText(e)}`);
  }

  const running = inFlight.get(key);
  if (running) return (await running) as T | null;

  const job = (async () => {
    const loaded = await load();
    if (!loaded) return null;
    if (loaded.complete) {
      memory.set(key, { at: Date.now(), value: loaded.value });
      try {
        await db.setCache(key, loaded.value);
      } catch (e) {
        logError(`[cache] write failed: ${errorText(e)}`);
      }
    }
    return loaded.value;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return (await job) as T | null;
}

/** For tests: forget everything held in memory. */
export function clearMemoryCache(): void {
  memory.clear();
  inFlight.clear();
}
