import type { Express } from 'express';

import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { MemoryDb } from './db/memoryDb.js';
import { SupabaseDb } from './db/supabaseDb.js';
import type { Db } from './db/types.js';
import { cloudinary, noCloudinary } from './lib/cloudinary.js';
import { noopMailer, resendMailer } from './lib/mailer.js';
import { googlePlaces, noPlaces } from './lib/places.js';
import { errorText, logError, logInfo } from './lib/log.js';
import { fcmSender, setPushSender } from './lib/push.js';
import { googleRouting, noRouting } from './lib/routing.js';

/** Builds the API from environment settings. Shared by the long-running server and Vercel. */
export function createFromEnv(): { app: Express; db: Db; config: Config } {
  const config = loadConfig();

  const db: Db =
    config.DB_DRIVER === 'supabase'
      ? new SupabaseDb(config.SUPABASE_URL as string, config.SUPABASE_SERVICE_ROLE_KEY as string)
      : new MemoryDb();

  const mailer = config.RESEND_API_KEY ? resendMailer({ apiKey: config.RESEND_API_KEY, from: config.MAIL_FROM }) : noopMailer;
  const places = config.GOOGLE_PLACES_API_KEY ? googlePlaces(config.GOOGLE_PLACES_API_KEY) : noPlaces;
  const photos =
    config.CLOUDINARY_CLOUD_NAME && config.CLOUDINARY_API_KEY && config.CLOUDINARY_API_SECRET
      ? cloudinary({ cloudName: config.CLOUDINARY_CLOUD_NAME, apiKey: config.CLOUDINARY_API_KEY, apiSecret: config.CLOUDINARY_API_SECRET })
      : noCloudinary;
  if (config.FIREBASE_SERVICE_ACCOUNT) {
    try {
      setPushSender(fcmSender(config.FIREBASE_SERVICE_ACCOUNT));
      logInfo('[push] on: Firebase push notifications are enabled');
    } catch (e) {
      logError(`[push] off: FIREBASE_SERVICE_ACCOUNT is not valid (${errorText(e)})`);
    }
  } else {
    logInfo('[push] off: FIREBASE_SERVICE_ACCOUNT is not set');
  }
  const routesKey =config.GOOGLE_ROUTES_API_KEY || config.GOOGLE_PLACES_API_KEY;
  const routing = routesKey ? googleRouting(routesKey) : noRouting;

  return { app: createApp(db, config, mailer, places, photos, routing), db, config };
}
