import { createFromEnv } from './bootstrap.js';

// Vercel runs the API as a serverless function: the Express app is the handler and
// nothing listens on a port. The overdue sweep cannot use a timer here; call
// GET /internal/overdue from a scheduler instead (see backend/README.md).
const { app } = createFromEnv();

export default app;
