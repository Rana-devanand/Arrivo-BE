import { createApp } from './app.js';
import { noopMailer, resendMailer } from './lib/mailer.js';
import { cloudinary, noCloudinary } from './lib/cloudinary.js';
import { googlePlaces, noPlaces } from './lib/places.js';
import { googleRouting, noRouting } from './lib/routing.js';
import { loadConfig } from './config.js';
import { MemoryDb } from './db/memoryDb.js';
import { SupabaseDb } from './db/supabaseDb.js';
import type { Db } from './db/types.js';
import { startOverdueJob } from './jobs/overdue.js';

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
const routesKey = config.GOOGLE_ROUTES_API_KEY || config.GOOGLE_PLACES_API_KEY;
const routing = routesKey ? googleRouting(routesKey) : noRouting;
const app = createApp(db, config, mailer, places, photos, routing);
const server = app.listen(config.PORT, () => {
  console.log(`Arrivo API listening on :${config.PORT} (db: ${config.DB_DRIVER}, env: ${config.NODE_ENV})`);
  if (config.DB_DRIVER === 'memory') {
    console.log('Memory database: data is lost on restart. Sign in with a token like "dev:alex".');
  }
});

const stopJob = config.ENABLE_OVERDUE_JOB === 'true' ? startOverdueJob(db) : () => undefined;

const shutdown = () => {
  stopJob();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
