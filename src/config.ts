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
    WATCH_BASE_URL: z.string().default('https://arrivo.app/w'),
    RESEND_API_KEY: z.string().optional(),
    /** Lets a scheduler call GET /v1/internal/overdue (for hosts without timers, e.g. Vercel). */
    CRON_SECRET: z.string().min(16).optional(),
    GOOGLE_PLACES_API_KEY: z.string().optional(),
    /** Routes API key. Falls back to GOOGLE_PLACES_API_KEY (one server key can serve both). */
    GOOGLE_ROUTES_API_KEY: z.string().optional(),
    CLOUDINARY_CLOUD_NAME: z.string().optional(),
    CLOUDINARY_API_KEY: z.string().optional(),
    CLOUDINARY_API_SECRET: z.string().optional(),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `- ${i.path.join('.') || 'env'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }
  return parsed.data;
}
