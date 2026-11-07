import 'dotenv/config';
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DB_DRIVER: z.enum(['supabase', 'memory']).default('memory'),
    SUPABASE_URL: z.string().url().optional().or(z.literal('')),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    CORS_ORIGINS: z.string().default(''),
    ENABLE_OVERDUE_JOB: z.enum(['true', 'false']).default('false'),
    ENABLE_DEV_ROUTES: z.enum(['true', 'false']).default('false'),
    /**
     * Where the public watch page lives (no trailing slash). Leave it unset: in production the
     * links use SITE_URL, and on a developer's machine they use the website run locally.
     * Set it only to force one address.
     */
    WATCH_BASE_URL: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    /** Lets a scheduler call GET /v1/internal/overdue (for hosts without timers, e.g. Vercel). */
    CRON_SECRET: z.string().min(16).optional(),
    GOOGLE_PLACES_API_KEY: z.string().optional(),
    /** Routes API key. Falls back to GOOGLE_PLACES_API_KEY (one server key can serve both). */
    GOOGLE_ROUTES_API_KEY: z.string().optional(),
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),
    /** Firebase service account key (JSON or base64 of it). Without it, push notifications are off. */
    FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
    /** The Arrivo website, where people pay for Arrivo Plus (no trailing slash). Needed for billing. */
    SITE_URL: z.string().url().optional(),
    /** Dodo Payments. Billing is on only when all of these are set. */
    DODO_API_KEY: z.string().optional(),
    DODO_MODE: z.enum(['test', 'live']).default('test'),
    DODO_WEBHOOK_SECRET: z.string().optional(),
    DODO_PRODUCT_PLUS_MONTHLY: z.string().optional(),
    DODO_PRODUCT_PLUS_6_MONTHS: z.string().optional(),
    DODO_PRODUCT_PLUS_YEARLY: z.string().optional(),
    /** Arrivo Plus Family, $49 a year. Optional: without it the Family plan says "not open yet". */
    DODO_PRODUCT_FAMILY_YEARLY: z.string().optional(),
    MAIL_FROM: z.string().default('Arrivo <invites@tryarrivo.com>'),
  })
  .superRefine((v, ctx) => {
    if (v.DB_DRIVER === 'supabase') {
      if (!v.SUPABASE_URL) ctx.addIssue({ code: 'custom', message: 'SUPABASE_URL is required when DB_DRIVER=supabase' });
      if (!v.SUPABASE_SERVICE_ROLE_KEY) {
        ctx.addIssue({ code: 'custom', message: 'SUPABASE_SERVICE_ROLE_KEY is required when DB_DRIVER=supabase' });
      }
    }
    if (v.NODE_ENV === 'production' && v.ENABLE_DEV_ROUTES === 'true') {
      ctx.addIssue({ code: 'custom', message: 'ENABLE_DEV_ROUTES is not allowed in production' });
    }
    if (v.NODE_ENV === 'production' && v.DB_DRIVER === 'memory') {
      ctx.addIssue({ code: 'custom', message: 'DB_DRIVER=memory is not allowed in production' });
    }
  });

export type Config = z.infer<typeof schema>;

/** The website on a developer's machine (`npm run dev` in Frontend/arrivo). */
export const DEV_SITE_URL = 'http://localhost:3000';
/** The live website, used in production when SITE_URL is not set. */
export const PROD_SITE_URL = 'https://tryarrivo.com';

type SiteEnv = Partial<Pick<Config, 'WATCH_BASE_URL' | 'SITE_URL' | 'NODE_ENV'>>;

const trimSlash = (s: string) => s.trim().replace(/\/+$/, '');

/**
 * The address a watch link starts with. An explicit WATCH_BASE_URL wins. Otherwise production
 * uses the live website (SITE_URL) and everything else uses the local website, so nobody has to
 * switch a setting when the server moves from a laptop to production.
 */
export function watchBaseUrl(c: SiteEnv): string {
  const explicit = c.WATCH_BASE_URL?.trim();
  if (explicit) return trimSlash(explicit);
  const site = c.NODE_ENV === 'production' ? (c.SITE_URL?.trim() || PROD_SITE_URL) : DEV_SITE_URL;
  return `${trimSlash(site)}/watch`;
}

/** Website addresses the browser may call this API from (the watch page): the live site, or the local one. */
export function siteOrigins(c: SiteEnv): string[] {
  if (c.NODE_ENV !== 'production') return [DEV_SITE_URL, 'http://127.0.0.1:3000'];
  const site = new URL(c.SITE_URL?.trim() || PROD_SITE_URL);
  const other = site.hostname.startsWith('www.') ? site.hostname.slice(4) : `www.${site.hostname}`;
  return [site.origin, `${site.protocol}//${other}${site.port ? `:${site.port}` : ''}`];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `- ${i.path.join('.') || 'env'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }
  return parsed.data;
}
