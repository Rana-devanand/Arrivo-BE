import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError, type ZodType } from 'zod';

import { AppError, badRequest } from '../lib/errors.js';

/** Parses [data] with [schema] or throws a 400 with readable details. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      'Invalid request',
      result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'bad_request', message: 'Invalid request' } });
    return;
  }
  const status = typeof err?.status === 'number' ? err.status : 500;
  if (status >= 500) {
    // Never log request bodies or coordinates.
    console.error('[error]', err instanceof Error ? err.message : 'unknown error');
  }
  res.status(status).json({
    error: { code: status >= 500 ? 'internal_error' : 'bad_request', message: status >= 500 ? 'Something went wrong' : 'Bad request' },
  });
};
