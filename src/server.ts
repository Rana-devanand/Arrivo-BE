import { createFromEnv } from './bootstrap.js';
import { startOverdueJob } from './jobs/overdue.js';

// Long-running server (your PC, Docker, Render, Railway, a VPS). Vercel uses src/vercel.ts.
const { app, db, config } = createFromEnv();

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
