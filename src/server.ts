import { createFromEnv } from './bootstrap.js';
import { startOverdueJob } from './jobs/overdue.js';
import { startSweepJob } from './jobs/sweep.js';

// Long-running server (your PC, Docker, Render, Railway, a VPS). Vercel uses src/vercel.ts.
const { app, db, config, places } = createFromEnv();

const server = app.listen(config.PORT, () => {
  console.log(`Arrivo API listening on :${config.PORT} (db: ${config.DB_DRIVER}, env: ${config.NODE_ENV})`);
  if (config.DB_DRIVER === 'memory') {
    console.log('Memory database: data is lost on restart. Sign in with a token like "dev:alex".');
  }
});

const stopJob = config.ENABLE_OVERDUE_JOB === 'true' ? startOverdueJob(db) : () => undefined;
// Same switch: a server that runs its own timers also runs the 5-minute sweep.
const stopSweep = config.ENABLE_OVERDUE_JOB === 'true' ? startSweepJob(db, places) : () => undefined;

const shutdown = () => {
  stopJob();
  stopSweep();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
