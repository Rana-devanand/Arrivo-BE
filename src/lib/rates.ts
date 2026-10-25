import { CURRENCIES } from '../domain/countries.js';
import { errorText, logError } from './log.js';

export interface Rates {
  base: 'USD';
  /** True when these came from the exchange-rate service (not just "1 USD = 1 USD"). */
  live: boolean;
  updatedAt: string | null;
  rates: Record<string, number>;
}

type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const SOURCE = 'https://open.er-api.com/v6/latest/USD';
const FRESH_MS = 12 * 60 * 60 * 1000;
/** After a failure, wait this long before asking again, so a broken service is not hammered. */
const RETRY_MS = 5 * 60 * 1000;

/**
 * Exchange rates against the US dollar, kept in memory for 12 hours. If the service cannot be
 * reached, the last good rates are kept; with none at all, only USD is offered and people see
 * dollars. Rates are for showing an approximate local price, never for charging.
 */
export function createRatesProvider(opts: { fetchFn?: FetchFn; now?: () => number } = {}) {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const now = opts.now ?? Date.now;
  let cached: Rates | null = null;
  let fetchedAt = 0;
  let failedAt = 0;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    try {
      const res = await fetchFn(SOURCE, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('rates status');
      const body = (await res.json()) as { result?: string; rates?: Record<string, unknown> };
      if (body.result !== 'success' || !body.rates) throw new Error('rates body');
      const rates: Record<string, number> = { USD: 1 };
      for (const code of CURRENCIES) {
        const v = body.rates[code];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) rates[code] = v;
      }
      cached = { base: 'USD', live: true, updatedAt: new Date(now()).toISOString(), rates };
      fetchedAt = now();
    } catch (e) {
      failedAt = now();
      logError(`exchange rates unavailable: ${errorText(e)}`);
    }
  }

  return async function get(): Promise<Rates> {
    const stale = !cached || now() - fetchedAt > FRESH_MS;
    if (stale && now() - failedAt > RETRY_MS) {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    return cached ?? { base: 'USD', live: false, updatedAt: null, rates: { USD: 1 } };
  };
}

export type RatesProvider = ReturnType<typeof createRatesProvider>;
