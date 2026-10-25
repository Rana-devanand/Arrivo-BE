import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import type { Config } from './config.js';
import type { Db } from './db/types.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { noopMailer, type Mailer } from './lib/mailer.js';
import { noCloudinary, type Cloudinary } from './lib/cloudinary.js';
import { noPlaces, type PlacesProvider } from './lib/places.js';
import { noRouting, type RoutingProvider } from './lib/routing.js';
import type { BillingConfig } from './lib/dodo.js';
import type { RatesProvider } from './lib/rates.js';
import { billingRoutes, type WithRawBody } from './routes/billing.js';
import { householdRoutes } from './routes/household.js';
import { planRoutes } from './routes/plan.js';
import { notificationRoutes } from './routes/notifications.js';
import { trackRoutes } from './routes/track.js';
import { placeRoutes } from './routes/places.js';
import { contactRoutes } from './routes/contacts.js';
import { invitationRoutes } from './routes/invitations.js';
import { journeyRoutes } from './routes/journeys.js';
import { profileRoutes } from './routes/profile.js';
import { safetyRoutes } from './routes/safety.js';
import { watchRoutes } from './routes/watch.js';
import { internalRoutes } from './routes/internal.js';

export function createApp(
  db: Db,
  config: Pick<Config, 'CORS_ORIGINS' | 'WATCH_BASE_URL' | 'ENABLE_DEV_ROUTES' | 'DB_DRIVER'> & { CRON_SECRET?: string },
  mailer: Mailer = noopMailer,
  places: PlacesProvider = noPlaces,
  photos: Cloudinary = noCloudinary,
  routing: RoutingProvider = noRouting,
  billing: BillingConfig | null = null,
  rates?: RatesProvider,
): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind a proxy (Vercel, Render...) the real client address is in X-Forwarded-For.
  if (process.env.TRUST_PROXY || process.env.VERCEL) app.set('trust proxy', 1);
  app.use(helmet());

  const origins = config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  // The website calls the checkout from the browser, so its address is always allowed.
  if (billing) origins.push(new URL(billing.siteUrl).origin);
  // Mobile apps do not send an Origin header; this only affects browsers.
  app.use(cors({ origin: origins.length ? origins : false }));
  // The raw bytes are kept for the payment webhook, whose signature covers them exactly.
  app.use(
    express.json({
      limit: '100kb',
      verify: (req, _res, buf) => {
        (req as WithRawBody).rawBody = Buffer.from(buf);
      },
    }),
  );

  // Minimal request log. Never logs bodies, query strings, tokens or coordinates.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const path = req.path.replace(/\/(watch|track)\/[^/]+/, '/$1/:token');
      if (process.env.NODE_ENV !== 'test') console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, db: config.DB_DRIVER });
  });

  // Per-IP safety net for the whole API.
  app.use('/v1', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));

  // Public routes first (no sign-in), then authenticated ones.
  app.use('/v1', watchRoutes(db));
  app.use('/v1', internalRoutes(db, config.CRON_SECRET));
  // Public (the background service has no sign-in): keep it before the signed-in routers.
  app.use('/v1', trackRoutes(db, places));
  // Plans, the website's checkout and Dodo's webhook are public; the routes that need a
  // sign-in say so themselves. It must come before the routers that require one for everything.
  app.use('/v1', billingRoutes(db, billing, rates));
  app.use('/v1', profileRoutes(db, photos));
  app.use('/v1', contactRoutes(db, { devRoutes: config.ENABLE_DEV_ROUTES === 'true', mailer }));
  app.use('/v1', invitationRoutes(db));
  app.use('/v1', householdRoutes(db));
  app.use('/v1', placeRoutes(db, places));
  app.use('/v1', planRoutes(db, routing));
  app.use('/v1', notificationRoutes(db));
  app.use('/v1', journeyRoutes(db, { watchBaseUrl: config.WATCH_BASE_URL, photos, places }));
  app.use('/v1', safetyRoutes(db));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
