export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);
export const gone = (message = 'No longer available') => new AppError(410, 'gone', message);
